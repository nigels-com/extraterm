/**
 * Copyright 2014 Simon Edwards <simon@simonzone.com>
 */

///<amd-dependency path="js-base64" />

import _ = require('lodash');
import commandframe = require('./commandframe');
import domutils = require('./domutils');
import termjs = require('term.js');
import child_process = require('child_process');
import events = require('events');
import scrollbar = require('./gui/scrollbar');
import util = require('./gui/util');

const EventEmitter = events.EventEmitter;

const debug = true;
let startTime: number = window.performance.now();
let registered = false;

function log(...msgs: any[]): void {
  if (debug) {
    const offset = window.performance.now() - startTime;
    const msg: string = msgs.reduce( (accu: string, value: string) => accu + value, "");
    console.timeStamp(msg);
    console.log(""+offset + ": " + msg);
  }
}

const ID = "EtTerminalTemplate";
const EXTRATERM_COOKIE_ENV = "EXTRATERM_COOKIE";
const SEMANTIC_TYPE = "data-extraterm-type";
const SEMANTIC_VALUE = "data-extraterm-value";
const ID_CONTAINER = "terminal_container";
const THEME_TAG = "theme";

const enum ApplicationMode {
  APPLICATION_MODE_NONE = 0,
  APPLICATION_MODE_HTML = 1,
  APPLICATION_MODE_OUTPUT_BRACKET_START = 2,
  APPLICATION_MODE_OUTPUT_BRACKET_END = 3,
  APPLICATION_MODE_REQUEST_FRAME = 4
}

/**
 * Create a new terminal.
 * 
 * A terminal is full terminal emulator with GUI intergration. It handles the
 * UI chrome wrapped around the smaller terminal emulation part (term.js).
 * 
 * See startUp().
 * 
 * @param {type} parentElement The DOM element under which the terminal will
 *     be placed.
 * @returns {Terminal}
 */
class EtTerminal extends HTMLElement {
  
  static TAG_NAME: string = "et-terminal";
  
  static USER_INPUT_EVENT: string = "user-input";
  
  static TERMINAL_RESIZE_EVENT: string = "terminal-resize";  
  
  /**
   * 
   */
  static init(): void {
    if (registered === false) {
      scrollbar.init();
      commandframe.init();
      window.document.registerElement(EtTerminal.TAG_NAME, {prototype: EtTerminal.prototype});
      registered = true;
    }
  }
  
  // WARNING: Fields like this will not be initialised automatically.
  private _container: HTMLDivElement;
  private _scrollbar: scrollbar;
  private _scrollSyncID: number;
  private _autoscroll: boolean;
  
  private _termContainer: HTMLElement;

  private _term: termjs.Terminal;
  private _htmlData: string;
  private _applicationMode: ApplicationMode;
  private _bracketStyle: string;
  private _lastBashBracket: string;
  
  /**
   * Blinking cursor
   * 
   * True means the cursor should blink, otherwise it doesn't.
   */
  set blinkingCursor(blink: boolean) {
    this._blinkingCursor = blink;
    if (this._term !== null) {
      this._term.setCursorBlink(blink);
    }
  }
  
  set themeCss(path: string) {
    const themeTag = <HTMLStyleElement> util.getShadowId(this, THEME_TAG);
    console.log("Setting theme css ",path);
    themeTag.innerHTML = "@import '" + path + "';";
  }
  
  private _blinkingCursor: boolean;
  private _title: string;
  private _super_lineToHTML: (line: any[]) => string;
  
  events: NodeJS.EventEmitter;
  
  private _tagCounter: number;
  
  private _initProperties(): void {
    this._scrollSyncID = -1;
    this._autoscroll = true;
    this._term = null;
    this._htmlData = null;
    this._applicationMode = ApplicationMode.APPLICATION_MODE_NONE;
    this._bracketStyle = null;
    this._lastBashBracket = null;
    this._blinkingCursor = false;
    this._title = "New Tab";
    this.events = new EventEmitter();
    this._tagCounter = 0;    
  }
  
  createdCallback(): void {
    this._initProperties();
    const shadow = util.createShadowRoot(this);

    const clone = this._createClone();
    shadow.appendChild(clone);
    this.startUp();
  }

  private _createClone(): Node {
    let template = <HTMLTemplate>window.document.getElementById(ID);
    if (template === null) {
      template = window.document.createElement('template');
      template.id = ID;

      const success_color = "#00ff00";
      const fail_color = "#ff0000";
      template.innerHTML = `<style>
        :host {
          display: block;
        }
        
        .terminal_container {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
        }

        .terminal_scrollbar {
            flex: 0;
            min-width: 15px;
            height: 100%;
        }

        .term_container {
            flex: 1;
            height: 100%;
        }

        .terminal {
            width: 100%;
            height: 100%;

            white-space: nowrap;
            
            overflow-x: scroll;
            overflow-y: hidden;
        }
        </style>
        <style id="theme"></style>
        <div class='terminal_container' id='${ID_CONTAINER}'>
          <div class='term_container'></div>
          <cb-scrollbar class='terminal_scrollbar'></cb-scrollbar>
        </div>`;
      window.document.body.appendChild(template);
    }

    return window.document.importNode(template.content, true);
  }

  /**
   * Get this terminal's title.
   */
  getTitle(): string {
    return this._title;
  }

  /**
   * Get the window which this terminal is on.
   * 
   * @returns {Window} The window object.
   */
  private _getWindow(): Window {
    return this.ownerDocument.defaultView;  
  }
  
  private _getDocument(): Document {
    return this.ownerDocument;
  }
  
  private _colors(): string[] {
    const colorList = termjs.Terminal.colors.slice();

    const linuxColors = [
      "#000000",
      "#b21818",
      "#18b218",
      "#b26818",
      "#3535ff",
      "#b218b2",
      "#18b2b2",
      "#b2b2b2",
      "#686868",
      "#ff5454",
      "#54ff54",
      "#ffff54",
      "#7373ff",
      "#ff54ff",
      "#54ffff",
      "#ffffff"];

    for (let i=0; i < linuxColors.length; i++) {
      colorList[i] = linuxColors[i];
    }

    colorList[256] = "#000000";
    colorList[257] = "#b2b2b2";

    return colorList;
  }

  /**
   * Start the terminal up.
   * 
   * This method should be called once all event handlers have been set up.
   */
  startUp(): void {
    this._container = <HTMLDivElement> util.getShadowId(this, ID_CONTAINER);
    this._scrollbar = <scrollbar>this._container.querySelector('cb-scrollbar');
    this._termContainer = <HTMLElement>this._container.firstElementChild;
    
    const cookie = "DEADBEEF";  // FIXME
    process.env[EXTRATERM_COOKIE_ENV] = cookie;

    this._term = new termjs.Terminal({
      cols: 80,
      rows: 30,
      colors: this._colors(),
      scrollback: 1000,
      cursorBlink: this._blinkingCursor,
      physicalScroll: true,
      applicationModeCookie: cookie
    });

    const defaultLineToHTML = this._term._lineToHTML;
    this._super_lineToHTML = this._term._lineToHTML;
    this._term._lineToHTML=  this._lineToHTML.bind(this);

    this._term.debug = true;
    this._term.on('title', this._handleTitle.bind(this));
    this._term.on('data', this._handleTermData.bind(this));
    this._getWindow().addEventListener('resize', this._handleResize.bind(this));
    this._term.on('key', this._handleKeyDown.bind(this));
    this._term.on('unknown-keydown', this._handleUnknownKeyDown.bind(this));
    this._term.on('manual-scroll', this._handleManualScroll.bind(this));
    
    // Application mode handlers    
    this._term.on('application-mode-start', this._handleApplicationModeStart.bind(this));
    this._term.on('application-mode-data', this._handleApplicationModeData.bind(this));
    this._term.on('application-mode-end', this._handleApplicationModeEnd.bind(this));

    // Window DOM event handlers
    this._getWindow().document.body.addEventListener('click', this._handleWindowClick.bind(this));

    this._term.open(this._termContainer);

    this._term.element.addEventListener('keypress', this._handleKeyPressTerminal.bind(this));
    this._term.element.addEventListener('keydown', this._handleKeyDownTerminal.bind(this));
    this._container.addEventListener('scroll-move', (ev: CustomEvent) => {
      this._syncManualScroll();  
    });

    this._term.write('\x1b[31mWelcome to Extraterm!\x1b[m\r\n');

    this._scrollbar.addEventListener('scroll', (ev: CustomEvent) => {
      this._autoscroll = ev.detail.isBottom;
    });
    
    const size = this._term.resizeToContainer();
    this._sendResize(size.cols, size.rows);
    
    this._syncScrolling();
  }
  
  /**
   * Synchronize the scrollbar with the term.
   */
  private _syncScrolling(): void {
    this._scrollbar.size = this._term.element.scrollHeight;
    if (this._autoscroll) {
      // Scroll to the bottom.
      this._scrollbar.position = Number.MAX_VALUE;
      this._term.element.scrollTop = this._term.element.scrollHeight - this._term.element.clientHeight;
    } else {
       this._term.element.scrollTop = this._scrollbar.position;
    }
    
    this._scrollSyncID = this._getWindow().requestAnimationFrame( (id: number): void => {
      this._syncScrolling();
    });
  }
  
  /**
   * Handle manual-scroll events from the term.
   * 
   * These happen when the user does something in the terminal which
   * intentionally scrolls the contents.
   */
  private _handleManualScroll(scrollDetail: termjs.ScrollDetail): void {
    this._autoscroll = scrollDetail.isBottom;
    if (scrollDetail.isBottom === false) {
      this._scrollbar.size = this._term.element.scrollHeight;
      this._scrollbar.position = scrollDetail.position;
    }
  }

  private _syncManualScroll(): void {
    var el = this._term.element;
    this._autoscroll = el.scrollTop === el.scrollHeight - el.clientHeight;
    this._scrollbar.position = el.scrollTop;
  }
  
  /**
   * Destroy the terminal.
   */
  destroy(): void {
    if (this._scrollSyncID !== -1) {
      cancelAnimationFrame(this._scrollSyncID);
    }
    
    // if (this._ptyBridge !== null) {
    //   this._ptyBridge.removeAllListeners();
    // 
    //   this._ptyBridge.kill('SIGHUP');
    //   this._ptyBridge.disconnect();
    //   this._ptyBridge = null;
    // }

    if (this._term !== null) {
      this._getWindow().removeEventListener('resize', this._handleResize);
      this._getWindow().document.body.removeEventListener('click', this._handleWindowClick);
      this._term.destroy();
    }
    this._term = null;
  }

  
  /**
   * Focus on this terminal.
   */
  focus(): void {
    if (this._term !== null) {
      this._term.focus();
    }
  }

  /**
   * Write data to the terminal screen.
   * 
   * @param text the stream of data to write.
   */
  write(text: string): void {
    if (this._term !== null) {
      this._term.write(text);
    }
  }
  
  /**
   * Send data to the pty and process connected to the terminal.
   * @param text the data to send.
   */
  send(text: string): void {
    if (this._term !== null) {
      this._sendDataToPty(text);
    }
  }
  
  /**
   * Scroll the terminal down as far as possible.
   */
  scrollToBottom(): void {
    this._term.scrollToBottom();
  }

  /**
   * Handler for window title change events from the pty.
   * 
   * @param title The new window title for this terminal.
   */
  _handleTitle(title: string): void {
    this._title = title;
    this.events.emit('title', this, title);
  }
  
  /**
   * Handle a resize event from the window.
   */
  _handleResize(): void {
    var size = this._term.resizeToContainer();
    this._sendResize(size.cols, size.rows);
  }

  _handleKeyDown(key: string, ev: KeyboardEvent): void {
    if (key !== null) {
      this._term.scrollToBottom();
    }
  }
  
  /**
   * Handle an unknown key down event from the term.
   */
  _handleUnknownKeyDown(ev: KeyboardEvent): boolean {
    this.events.emit('unknown-keydown', this, ev);
    return false;
  }

  _handleKeyPressTerminal(ev: KeyboardEvent): void {
//    console.log("._handleKeyPressTerminal: ", ev.keyCode);
    this._term.keyPress(ev);
  }

  _handleKeyDownTerminal(ev: KeyboardEvent): void {
    let frames: commandframe[];
    let index: number;

    // Key down on a command frame.
    if ((<HTMLElement>ev.target).tagName === "ET-COMMANDFRAME") {
      if (ev.keyCode === 27) {
        // 27 = esc.
        this._term.element.focus();
        this._term.scrollToBottom();
        ev.preventDefault();
        return;

      } else if (ev.keyCode === 32 && ev.ctrlKey) {
        // 32 = space
        (<commandframe>ev.target).openMenu();
        ev.preventDefault();
        return;

      } else if (ev.keyCode === 38) {
        // 38 = update arrow.

        // Note ugly convert-to-array code. ES6 Array.from() help us!
        frames = Array.prototype.slice.call(this._term.element.querySelectorAll("et-commandframe"));
        index = frames.indexOf(<commandframe>ev.target);
        if (index > 0) {
          frames[index-1].focusLast();
        }
        ev.preventDefault();
        return;

      } else if (ev.keyCode === 40) {
        // 40 = down arros.

        frames = Array.prototype.slice.call(this._term.element.querySelectorAll("et-commandframe"));
        index = frames.indexOf(<commandframe>ev.target);
        if (index < frames.length -1) {
          frames[index+1].focusFirst();
        }
        ev.preventDefault();
        return;
      }

    } else if (ev.target === this._term.element) {
      // In normal typing mode.

      if (ev.keyCode === 32 && ev.ctrlKey) {
        // Enter cursor mode.
        // 32 = space.
        const lastFrame = <commandframe>this._term.element.querySelector("et-commandframe:last-of-type");
        if (lastFrame !== null) {
          lastFrame.focusLast();
        }
        ev.preventDefault();
        return;
      }
    }


    this._term.keyDown(ev);
  }

  /**
   * Handle when the embedded term.js enters start of application mode.
   * 
   * @param {array} params The list of parameter which were specified in the
   *     escape sequence.
   */
  _handleApplicationModeStart(params: string[]): void {
    log("application-mode started! ",params);
    if (params.length === 1) {
      // Normal HTML mode.
      this._applicationMode = ApplicationMode.APPLICATION_MODE_HTML;

    } else if(params.length >= 2) {
      switch ("" + params[1]) {
        case "" + ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_START:
          this._applicationMode = ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_START;
          this._bracketStyle = params[2];
          break;

        case "" + ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_END:
          this._applicationMode = ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_END;
          log("Starting APPLICATION_MODE_OUTPUT_BRACKET_END");
          break;
          
        case "" + ApplicationMode.APPLICATION_MODE_REQUEST_FRAME:
          this._applicationMode = ApplicationMode.APPLICATION_MODE_REQUEST_FRAME;
          log("Starting APPLICATION_MODE_REQUEST_FRAME");
          break;
          
        default:
          log("Unrecognized application escape parameters.");
          break;
      }
    }
    this._htmlData = "";
  }

  /**
   * Handle incoming data while in application mode.
   * 
   * @param {string} data The new data.
   */
  _handleApplicationModeData(data: string): void {
    log("html-mode data!", data);
    if (this._applicationMode !== ApplicationMode.APPLICATION_MODE_NONE) {
      this._htmlData = this._htmlData + data;
    }
  }

  /**
   * Handle the exit from application mode.
   */
  _handleApplicationModeEnd(): void {
    let el: HTMLElement;
    let startdivs: NodeList;
    
    switch (this._applicationMode) {
      case ApplicationMode.APPLICATION_MODE_HTML:
        el = this._getWindow().document.createElement("div");
        el.innerHTML = this._htmlData;
        this._term.appendElement(el);
        break;

      case ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_START:
        startdivs = this._term.element.querySelectorAll("et-commandframe:not([return-code])");
        log("startdivs:", startdivs);
        if (startdivs.length !== 0) {
          break;  // Don't open a new frame.
        }
        
        // Create and set up a new command-frame.
        el = this._getWindow().document.createElement("et-commandframe");

        el.addEventListener('close-request', (function() {
          el.remove();
          this.focus();
        }).bind(this));

        el.addEventListener('type', (function(ev: CustomEvent) {
          this._sendDataToPty(ev.detail);
        }).bind(this));

        // el.addEventListener('copy-clipboard-request', (function(ev: CustomEvent) {
        //   var clipboard = gui.Clipboard.get();
        //   clipboard.set(ev.detail, 'text');
        // }).bind(this));

        el.addEventListener('frame-pop-out', (ev: CustomEvent): void => {
          this.events.emit('frame-pop-out', this, ev.detail);
        });
        
        var cleancommand = this._htmlData;
        if (this._bracketStyle === "bash") {
          // Bash includes the history number. Remove it.
          var trimmed = this._htmlData.trim();
          cleancommand = trimmed.slice(trimmed.indexOf(" ")).trim();
        }
        el.setAttribute('command-line', cleancommand);
        el.setAttribute('tag', "" + this._getNextTag());
        this._term.appendElement(el);
        break;

      case ApplicationMode.APPLICATION_MODE_OUTPUT_BRACKET_END:
        startdivs = this._term.element.querySelectorAll("et-commandframe:not([return-code])");
        log("startdivs:", startdivs);
        if (startdivs.length !== 0) {

          this.preserveScroll(function() {
            this._term.moveRowsToScrollback();
            const outputdiv = <HTMLDivElement>startdivs[startdivs.length-1];
            let node = outputdiv.nextSibling;

            const nodelist: Node[] = [];
            while (node !== null) {
              nodelist.push(node);
              node = node.nextSibling;
            }
            nodelist.forEach(function(node) {
              outputdiv.appendChild(node);
            });
            outputdiv.setAttribute('return-code', this._htmlData);
            outputdiv.className = "extraterm_output";
          });
        }

        break;

      case ApplicationMode.APPLICATION_MODE_REQUEST_FRAME:
        this.handleRequestFrame(this._htmlData);
        break;
        
      default:
        break;
    }
    this._applicationMode = ApplicationMode.APPLICATION_MODE_NONE;

    log("html-mode end!",this._htmlData);
    this._htmlData = null;
  }

// FIXME delete this.
  preserveScroll(task:()=>void): void {
    const scrollatbottom = this._term.isScrollAtBottom();
    task.call(this);
    if (scrollatbottom) {
      // Scroll the terminal down to the bottom.
      this._term.scrollToBottom();
    }
  }

  /**
   * Handle a click inside the terminal.
   * 
   * @param {event} event
   */
// FIXME this is an obsolete way of working.
  _handleWindowClick(event: Event) {
  //      log("body on click!",event);
    const type = event.srcElement.getAttribute(SEMANTIC_TYPE);
    const value = event.srcElement.getAttribute(SEMANTIC_VALUE);
    this._handleMineTypeClick(type, value);
  }

  /**
   * Handle new stdout data from the pty.
   * 
   * @param {string} data New data.
   */
  _handlePtyStdoutData (data: string): void {
    log("incoming data:",""+data);
    this._term.write("" + data);
  }

  /**
   * Handle new stderr data from the pty.
   * 
   * @param {type} data New data.
   */
  _handlePtyStderrData(data: string): void {
    this._term.write(data);
  }

  /**
   * Handle a pty close event.
   * 
   * @param {string} data
   */
  _handlePtyClose(data: string): void {
    // this._ptyBridge = null;
    this.events.emit('ptyclose', this);
  }
  
  /**
   * Handle data coming from the user.
   * 
   * This just pushes the keys from the user through to the pty.
   * @param {string} data The data to process.
   */
  _handleTermData(data: string): void {
    this._sendDataToPty(data);
  }

  /**
   * Send data to the pseudoterminal.
   * 
   * @param {string} text
   */
  _sendDataToPty(text: string): void {
    const event = new CustomEvent(EtTerminal.USER_INPUT_EVENT, { detail: {data: text } });
    this.dispatchEvent(event);
  }

  /**
   * Send a resize message to the pty.
   * 
   * @param {number} cols The new number of columns in the terminal.
   * @param {number} rows The new number of rows in the terminal.
   */
  _sendResize(cols: number, rows: number, callback?: Function): void {
    const event = new CustomEvent(EtTerminal.TERMINAL_RESIZE_EVENT, { detail: {columns: cols, rows: rows } });
    this.dispatchEvent(event);    
  }
    
  // git diff scroll speed test
  // --------------------------
  // Original with innerHTML: 11-14ms per line scroll update.
  // DOM work, no decorate:   10-15ms per line scroll update.
  // decorate SPAN:           20-25ms per line scroll update.
  // decorate et-word:        28-34ms per line scroll update.
  // SPAN with innerHTML:     12-19ms per line scroll update.
  // et-word with innerHTML:  20-24ms per line scroll update.

  _lineToHTML(line: any[]): string {
    const len = line.length;
    let whiteState = true;
    let tempLine: any[];
    let tuple: any;
    let output = "";
    const WORD_SPAN = "<span class='et-word' tabindex='-1'>";

    tempLine = [];
    for (let i=0; i<len; i++) {
      tuple = line[i];
      const isWhite = tuple[1] === ' ';
      if (whiteState !== isWhite) {
        if (tempLine.length !== 0) {
          if (whiteState) {
            output = output + this._super_lineToHTML.call(this._term, tempLine);
          } else {
            output = output + WORD_SPAN + this._super_lineToHTML.call(this._term, tempLine) + "</span>";
          }
          tempLine = [];
        }
        whiteState = isWhite;
      }
      tempLine.push(tuple);
    }

    if (tempLine.length !== 0) {
      if (whiteState) {
        output = output + this._super_lineToHTML.call(this._term, tempLine);
      } else {
        output = output + WORD_SPAN + this._super_lineToHTML.call(this._term, tempLine) + "</span>";
      }
    }

    return output;
  }
  
  handleRequestFrame(frameId: string): void {
    const sourceFrame: commandframe = this._findFrame(frameId);
    const data = sourceFrame !== null ? sourceFrame.text : "";
    const lines = data.split("\n");
    let encodedData: string = "";
    lines.forEach( (line: string) => {
      encodedData = Base64.encode(line +"\n");
      this._sendDataToPty(encodedData+"\n");
    });
      
    this._sendDataToPty("\x04");
    
    if (encodedData.length !== 0) {
      this._sendDataToPty("\x04");
    }
  }

  /**
   * Find a command frame by ID.
   */
  _findFrame(frameId: string): commandframe {
    if (/[^0-9]/.test(frameId)) {
      return null;
    }
    const matches = this._term.element.querySelectorAll("et-commandframe[tag='" + frameId + "']");
    return matches.length === 0 ? null : <commandframe>matches[0];
  }
  
  /**
   * Process a click on a item of the given mimetype and value.
   * 
   * @param {string} type
   * @param {string} value
   */
  _handleMineTypeClick(type: string, value: string): void {
    if (type === "directory") {
      this._sendDataToPty("cd " + value + "\n"); // FIXME escaping
    }
  }
  
  _getNextTag(): number {
    this._tagCounter++;
    return this._tagCounter;
  }
}
export = EtTerminal;