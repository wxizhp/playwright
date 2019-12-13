/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as EventEmitter from 'events';
import * as frames from '../frames';
import { assert, debugError, helper, RegisteredListener } from '../helper';
import * as js from '../javascript';
import * as dom from '../dom';
import * as network from '../network';
import { TargetSession } from './Connection';
import { Events } from '../events';
import { ExecutionContextDelegate, EVALUATION_SCRIPT_URL } from './ExecutionContext';
import { NetworkManager, NetworkManagerEvents } from './NetworkManager';
import { Page, PageDelegate } from '../page';
import { Protocol } from './protocol';
import { DOMWorldDelegate } from './JSHandle';
import * as dialog from '../dialog';
import { Browser } from './Browser';
import { BrowserContext } from '../browserContext';
import { RawMouseImpl, RawKeyboardImpl } from './Input';
import * as input from '../input';
import * as types from '../types';
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const UTILITY_WORLD_NAME = '__playwright_utility_world__';
const BINDING_CALL_MESSAGE = '__playwright_binding_call__';

export const FrameManagerEvents = {
  FrameNavigatedWithinDocument: Symbol('FrameNavigatedWithinDocument'),
  FrameAttached: Symbol('FrameAttached'),
  FrameDetached: Symbol('FrameDetached'),
  FrameNavigated: Symbol('FrameNavigated'),
  LifecycleEvent: Symbol('LifecycleEvent'),
};

const frameDataSymbol = Symbol('frameData');
type FrameData = {
  id: string,
};

let lastDocumentId = 0;

export class FrameManager extends EventEmitter implements PageDelegate {
  readonly rawMouse: RawMouseImpl;
  readonly rawKeyboard: RawKeyboardImpl;
  _session: TargetSession;
  readonly _page: Page;
  private readonly _networkManager: NetworkManager;
  private readonly _frames: Map<string, frames.Frame>;
  private readonly _contextIdToContext: Map<number, js.ExecutionContext>;
  private _isolatedWorlds: Set<string>;
  private _sessionListeners: RegisteredListener[] = [];
  private _mainFrame: frames.Frame;
  private readonly _bootstrapScripts: string[] = [];

  constructor(browserContext: BrowserContext) {
    super();
    this.rawKeyboard = new RawKeyboardImpl();
    this.rawMouse = new RawMouseImpl();
    this._networkManager = new NetworkManager(this);
    this._frames = new Map();
    this._contextIdToContext = new Map();
    this._isolatedWorlds = new Set();
    this._page = new Page(this, browserContext);
    this._networkManager.on(NetworkManagerEvents.Request, event => this._page.emit(Events.Page.Request, event));
    this._networkManager.on(NetworkManagerEvents.Response, event => this._page.emit(Events.Page.Response, event));
    this._networkManager.on(NetworkManagerEvents.RequestFailed, event => this._requestFailed(event));
    this._networkManager.on(NetworkManagerEvents.RequestFinished, event => this._page.emit(Events.Page.RequestFinished, event));
  }

  setSession(session: TargetSession) {
    helper.removeEventListeners(this._sessionListeners);
    this.disconnectFromTarget();
    this._session = session;
    this.rawKeyboard.setSession(session);
    this.rawMouse.setSession(session);
    this._addSessionListeners();
    this._networkManager.setSession(session);
    this._isolatedWorlds = new Set();
  }

  // This method is called for provisional targets as well. The session passed as the parameter
  // may be different from the current session and may be destroyed without becoming current.
  async _initializeSession(session: TargetSession) {
    const promises : Promise<any>[] = [
      // Page agent must be enabled before Runtime.
      session.send('Page.enable'),
      session.send('Page.getResourceTree').then(({frameTree}) => this._handleFrameTree(frameTree)),
      // Resource tree should be received before first execution context.
      session.send('Runtime.enable').then(() => this._ensureIsolatedWorld(UTILITY_WORLD_NAME)),
      session.send('Console.enable'),
      session.send('Page.setInterceptFileChooserDialog', { enabled: true }),
      this._networkManager.initializeSession(session),
    ];
    if (!session.isProvisional()) {
      // FIXME: move dialog agent to web process.
      // Dialog agent resides in the UI process and should not be re-enabled on navigation.
      promises.push(session.send('Dialog.enable'));
    }
    if (this._page._state.userAgent !== null)
      promises.push(session.send('Page.overrideUserAgent', { value: this._page._state.userAgent }));
    if (this._page._state.mediaType !== null)
      promises.push(session.send('Page.setEmulatedMedia', { media: this._page._state.mediaType || '' }));
    if (this._page._state.javascriptEnabled !== null)
      promises.push(session.send('Emulation.setJavaScriptEnabled', { enabled: this._page._state.javascriptEnabled }));
    if (this._page._state.bypassCSP !== null)
      promises.push(session.send('Page.setBypassCSP', { enabled: this._page._state.bypassCSP }));
    await Promise.all(promises);
  }

  didClose() {
    helper.removeEventListeners(this._sessionListeners);
    this.disconnectFromTarget();
  }

  _addSessionListeners() {
    this._sessionListeners = [
      helper.addEventListener(this._session, 'Page.frameNavigated', event => this._onFrameNavigated(event.frame, false)),
      helper.addEventListener(this._session, 'Page.navigatedWithinDocument', event => this._onFrameNavigatedWithinDocument(event.frameId, event.url)),
      helper.addEventListener(this._session, 'Page.frameAttached', event => this._onFrameAttached(event.frameId, event.parentFrameId)),
      helper.addEventListener(this._session, 'Page.frameDetached', event => this._onFrameDetached(event.frameId)),
      helper.addEventListener(this._session, 'Page.frameStoppedLoading', event => this._onFrameStoppedLoading(event.frameId)),
      helper.addEventListener(this._session, 'Page.loadEventFired', event => this._onLifecycleEvent(event.frameId, 'load')),
      helper.addEventListener(this._session, 'Page.domContentEventFired', event => this._onLifecycleEvent(event.frameId, 'domcontentloaded')),
      helper.addEventListener(this._session, 'Runtime.executionContextCreated', event => this._onExecutionContextCreated(event.context)),
      helper.addEventListener(this._session, 'Console.messageAdded', event => this._onConsoleMessage(event)),
      helper.addEventListener(this._session, 'Dialog.javascriptDialogOpening', event => this._onDialog(event)),
      helper.addEventListener(this._session, 'Page.fileChooserOpened', event => this._onFileChooserOpened(event))
    ];
  }

  disconnectFromTarget() {
    for (const context of this._contextIdToContext.values()) {
      (context._delegate as ExecutionContextDelegate)._dispose();
      context.frame()._contextDestroyed(context);
    }
    // this._mainFrame = null;
  }

  networkManager(): NetworkManager {
    return this._networkManager;
  }

  _onFrameStoppedLoading(frameId: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    const hasDOMContentLoaded = frame._firedLifecycleEvents.has('domcontentloaded');
    const hasLoad = frame._firedLifecycleEvents.has('load');
    frame._lifecycleEvent('domcontentloaded');
    frame._lifecycleEvent('load');
    this.emit(FrameManagerEvents.LifecycleEvent, frame);
    if (frame === this.mainFrame() && !hasDOMContentLoaded)
      this._page.emit(Events.Page.DOMContentLoaded);
    if (frame === this.mainFrame() && !hasLoad)
      this._page.emit(Events.Page.Load);
  }

  _onLifecycleEvent(frameId: string, event: frames.LifecycleEvent) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    frame._lifecycleEvent(event);
    this.emit(FrameManagerEvents.LifecycleEvent, frame);
    if (frame === this.mainFrame()) {
      if (event === 'load')
        this._page.emit(Events.Page.Load);
      if (event === 'domcontentloaded')
        this._page.emit(Events.Page.DOMContentLoaded);
    }
  }

  _handleFrameTree(frameTree: Protocol.Page.FrameResourceTree) {
    this._onFrameAttached(frameTree.frame.id, frameTree.frame.parentId);
    this._onFrameNavigated(frameTree.frame, true);
    if (!frameTree.childFrames)
      return;

    for (const child of frameTree.childFrames)
      this._handleFrameTree(child);
  }

  page(): Page {
    return this._page;
  }

  mainFrame(): frames.Frame {
    return this._mainFrame;
  }

  frames(): Array<frames.Frame> {
    return Array.from(this._frames.values());
  }

  frame(frameId: string): frames.Frame | null {
    return this._frames.get(frameId) || null;
  }

  _frameData(frame: frames.Frame): FrameData {
    return (frame as any)[frameDataSymbol];
  }

  _onFrameAttached(frameId: string, parentFrameId: string | null) {
    assert(!this._frames.has(frameId));
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId) : null;
    const frame = new frames.Frame(this._page, parentFrame);
    const data: FrameData = {
      id: frameId,
    };
    frame[frameDataSymbol] = data;
    this._frames.set(frameId, frame);
    if (!parentFrame)
      this._mainFrame = frame;
    this.emit(FrameManagerEvents.FrameAttached, frame);
    this._page.emit(Events.Page.FrameAttached, frame);
    return frame;
  }

  _onFrameNavigated(framePayload: Protocol.Page.Frame, initial: boolean) {
    const isMainFrame = !framePayload.parentId;
    const frame = isMainFrame ? this._mainFrame : this._frames.get(framePayload.id);

    // Detach all child frames first.
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
    if (isMainFrame) {
      // Update frame id to retain frame identity on cross-process navigation.
      const data = this._frameData(frame);
      this._frames.delete(data.id);
      data.id = framePayload.id;
      this._frames.set(data.id, frame);
    }

    for (const context of this._contextIdToContext.values()) {
      if (context.frame() === frame) {
        const delegate = context._delegate as ExecutionContextDelegate;
        delegate._dispose();
        this._contextIdToContext.delete(delegate._contextId);
        frame._contextDestroyed(context);
      }
    }

    // Auto-increment to avoid cross-process loaderId clash.
    const documentId = framePayload.loaderId + '::' + (++lastDocumentId);
    if (!initial)
      frame._onExpectedNewDocumentNavigation(documentId);
    frame._onCommittedNewDocumentNavigation(framePayload.url, framePayload.name, documentId);

    this.emit(FrameManagerEvents.FrameNavigated, frame);
    this._page.emit(Events.Page.FrameNavigated, frame);
  }

  _onFrameNavigatedWithinDocument(frameId: string, url: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    frame._onCommittedSameDocumentNavigation(url);
    this.emit(FrameManagerEvents.FrameNavigatedWithinDocument, frame);
    this.emit(FrameManagerEvents.FrameNavigated, frame);
    this._page.emit(Events.Page.FrameNavigated, frame);
  }

  _onFrameDetached(frameId: string) {
    const frame = this._frames.get(frameId);
    if (frame)
      this._removeFramesRecursively(frame);
  }

  _onExecutionContextCreated(contextPayload : Protocol.Runtime.ExecutionContextDescription) {
    if (this._contextIdToContext.has(contextPayload.id))
      return;
    const frameId = contextPayload.frameId;
    // If the frame was attached manually there is no navigation event.
    // FIXME: support frameAttached event in WebKit protocol.
    const frame = this._frames.get(frameId) || null;
    if (!frame)
      return;
    const context = new js.ExecutionContext(new ExecutionContextDelegate(this._session, contextPayload));
    if (frame) {
      context._domWorld = new dom.DOMWorld(context, new DOMWorldDelegate(this, frame));
      if (contextPayload.isPageContext)
        frame._contextCreated('main', context);
      else if (contextPayload.name === UTILITY_WORLD_NAME)
        frame._contextCreated('utility', context);
    }
    this._contextIdToContext.set(contextPayload.id, context);
  }

  executionContextById(contextId: number): js.ExecutionContext {
    const context = this._contextIdToContext.get(contextId);
    assert(context, 'INTERNAL ERROR: missing context with id = ' + contextId);
    return context;
  }

  _removeFramesRecursively(frame: frames.Frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
    frame._onDetached();
    this._frames.delete(this._frameData(frame).id);
    this.emit(FrameManagerEvents.FrameDetached, frame);
    this._page.emit(Events.Page.FrameDetached, frame);
  }

  async navigateFrame(frame: frames.Frame, url: string, options: frames.GotoOptions = {}): Promise<network.Response | null> {
    const {
      timeout = this._page._timeoutSettings.navigationTimeout(),
      waitUntil = (['load'] as frames.LifecycleEvent[])
    } = options;
    const watchDog = new frames.LifecycleWatcher(frame, waitUntil, timeout);
    await this._session.send('Page.navigate', {url, frameId: this._frameData(frame).id});
    const error = await Promise.race([
      watchDog.timeoutOrTerminationPromise,
      watchDog.newDocumentNavigationPromise,
      watchDog.sameDocumentNavigationPromise,
    ]);
    watchDog.dispose();
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  async waitForFrameNavigation(frame: frames.Frame, options: frames.NavigateOptions = {}): Promise<network.Response | null> {
    const {
      timeout = this._page._timeoutSettings.navigationTimeout(),
      waitUntil = (['load'] as frames.LifecycleEvent[])
    } = options;
    const watchDog = new frames.LifecycleWatcher(frame, waitUntil, timeout);
    const error = await Promise.race([
      watchDog.timeoutOrTerminationPromise,
      watchDog.newDocumentNavigationPromise,
      watchDog.sameDocumentNavigationPromise,
    ]);
    watchDog.dispose();
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  async setFrameContent(frame: frames.Frame, html: string, options: frames.NavigateOptions = {}) {
    // We rely upon the fact that document.open() will trigger Page.loadEventFired.
    const {
      timeout = this._page._timeoutSettings.navigationTimeout(),
      waitUntil = (['load'] as frames.LifecycleEvent[])
    } = options;
    const watchDog = new frames.LifecycleWatcher(frame, waitUntil, timeout);
    await frame.evaluate(html => {
      document.open();
      document.write(html);
      document.close();
    }, html);
    const error = await Promise.race([
      watchDog.timeoutOrTerminationPromise,
      watchDog.lifecyclePromise,
    ]);
    watchDog.dispose();
    if (error)
      throw error;
  }

  async _onConsoleMessage(event: Protocol.Console.messageAddedPayload) {
    const { type, level, text, parameters, url, line: lineNumber, column: columnNumber } = event.message;
    if (level === 'debug' && parameters && parameters[0].value === BINDING_CALL_MESSAGE) {
      const parsedObjectId = JSON.parse(parameters[1].objectId);
      const context = this._contextIdToContext.get(parsedObjectId.injectedScriptId);
      this._page._onBindingCalled(parameters[2].value, context);
      return;
    }
    let derivedType: string = type;
    if (type === 'log')
      derivedType = level;
    else if (type === 'timing')
      derivedType = 'timeEnd';

    const mainFrameContext = await this.mainFrame().executionContext();
    const handles = (parameters || []).map(p => {
      let context: js.ExecutionContext | null = null;
      if (p.objectId) {
        const objectId = JSON.parse(p.objectId);
        context = this._contextIdToContext.get(objectId.injectedScriptId);
      } else {
        context = mainFrameContext;
      }
      return context._createHandle(p);
    });
    this._page._addConsoleMessage(derivedType, handles, { url, lineNumber: lineNumber - 1, columnNumber: columnNumber - 1 }, handles.length ? undefined : text);
  }

  _onDialog(event: Protocol.Dialog.javascriptDialogOpeningPayload) {
    this._page.emit(Events.Page.Dialog, new dialog.Dialog(
      event.type as dialog.DialogType,
      event.message,
      async (accept: boolean, promptText?: string) => {
        await this._session.send('Dialog.handleJavaScriptDialog', { accept, promptText });
      },
      event.defaultPrompt));
  }

  async _onFileChooserOpened(event: {frameId: Protocol.Network.FrameId, element: Protocol.Runtime.RemoteObject}) {
    const context = await this.frame(event.frameId)._mainContext();
    const handle = context._createHandle(event.element).asElement()!;
    this._page._onFileChooserOpened(handle);
  }

  setExtraHTTPHeaders(extraHTTPHeaders: network.Headers): Promise<void> {
    return this._networkManager.setExtraHTTPHeaders(extraHTTPHeaders);
  }

  async _ensureIsolatedWorld(name: string) {
    if (this._isolatedWorlds.has(name))
      return;
    this._isolatedWorlds.add(name);
    await this._session.send('Page.createIsolatedWorld', {
      name,
      source: `//# sourceURL=${EVALUATION_SCRIPT_URL}`
    });
  }

  async setUserAgent(userAgent: string): Promise<void> {
    await this._session.send('Page.overrideUserAgent', { value: userAgent });
  }

  async setJavaScriptEnabled(enabled: boolean): Promise<void> {
    await this._session.send('Emulation.setJavaScriptEnabled', { enabled });
  }

  async setBypassCSP(enabled: boolean): Promise<void> {
    await this._session.send('Page.setBypassCSP', { enabled });
  }

  async setViewport(viewport: types.Viewport): Promise<void> {
    if (viewport.isMobile || viewport.isLandscape || viewport.hasTouch)
      throw new Error('Not implemented');
    const width = viewport.width;
    const height = viewport.height;
    await this._session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: viewport.deviceScaleFactor || 1 });
  }

  async setEmulateMedia(mediaType: input.MediaType | null, mediaColorScheme: input.MediaColorScheme | null): Promise<void> {
    if (mediaColorScheme !== null)
      throw new Error('Not implemented');
    await this._session.send('Page.setEmulatedMedia', { media: mediaType || '' });
  }

  setCacheEnabled(enabled: boolean): Promise<void> {
    return this._networkManager.setCacheEnabled(enabled);
  }

  async reload(options?: frames.NavigateOptions): Promise<network.Response | null> {
    const [response] = await Promise.all([
      this._page.waitForNavigation(options),
      this._session.send('Page.reload')
    ]);
    return response;
  }

  async _go<T extends keyof Protocol.CommandParameters>(command: T, options?: frames.NavigateOptions): Promise<network.Response | null> {
    const [response] = await Promise.all([
      this._page.waitForNavigation(options),
      this._session.send(command).then(() => null),
    ]).catch(error => {
      if (error instanceof Error && error.message.includes(`Protocol error (${command}): Failed to go`))
        return [null];
      throw error;
    });
    return response;
  }

  goBack(options?: frames.NavigateOptions): Promise<network.Response | null> {
    return this._go('Page.goBack', options);
  }

  goForward(options?: frames.NavigateOptions): Promise<network.Response | null> {
    return this._go('Page.goForward', options);
  }

  async exposeBinding(name: string, bindingFunction: string): Promise<void> {
    const script = `self.${name} = (param) => console.debug('${BINDING_CALL_MESSAGE}', {}, param); ${bindingFunction}`;
    this._bootstrapScripts.unshift(script);
    const source = this._bootstrapScripts.join(';');
    await this._session.send('Page.setBootstrapScript', { source });
    await Promise.all(this.frames().map(frame => frame.evaluate(script).catch(debugError)));
  }

  async evaluateOnNewDocument(script: string): Promise<void> {
    this._bootstrapScripts.push(script);
    const source = this._bootstrapScripts.join(';');
    // TODO(yurys): support process swap on navigation.
    await this._session.send('Page.setBootstrapScript', { source });
  }

  async closePage(runBeforeUnload: boolean): Promise<void> {
    if (runBeforeUnload)
      throw new Error('Not implemented');
    (this._page.browser() as Browser)._closePage(this._page);
  }

  getBoundingBoxForScreenshot(handle: dom.ElementHandle<Node>): Promise<types.Rect | null> {
    return handle.boundingBox();
  }

  canScreenshotOutsideViewport(): boolean {
    return false;
  }

  async setBackgroundColor(color?: { r: number; g: number; b: number; a: number; }): Promise<void> {
    // TODO: line below crashes, sort it out.
    this._session.send('Page.setDefaultBackgroundColorOverride', { color });
  }

  async takeScreenshot(format: string, options: types.ScreenshotOptions, viewport: types.Viewport): Promise<Buffer> {
    const rect = options.clip || { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const result = await this._session.send('Page.snapshotRect', { ...rect, coordinateSystem: options.fullPage ? 'Page' : 'Viewport' });
    const prefix = 'data:image/png;base64,';
    let buffer = Buffer.from(result.dataURL.substr(prefix.length), 'base64');
    if (format === 'jpeg')
      buffer = jpeg.encode(PNG.sync.read(buffer)).data;
    return buffer;
  }

  async resetViewport(oldSize: types.Size): Promise<void> {
    await this._session.send('Emulation.setDeviceMetricsOverride', { ...oldSize, deviceScaleFactor: 0 });
  }

  private _requestFailed(request: network.Request) {
    if (request.isNavigationRequest() && !request.failure().errorText.includes('cancelled')) {
      request.frame()._onExpectedNewDocumentNavigation('fake-loader-id', request.url());
      request.frame()._onAbortedNewDocumentNavigation('fake-loader-id', request.failure().errorText);
    }
    this._page.emit(Events.Page.RequestFailed, request);
  }
}
