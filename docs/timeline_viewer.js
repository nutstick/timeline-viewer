'use strict';

// eslint-disable-next-line no-unused-vars
class Viewer {
  constructor() {
    this.params = new URL(location.href).searchParams;
    this.syncView = new SyncView();
    this.timelineURL = this.params.get('loadTimelineFromURL');
    this.timelineId = null;
    this.timelineProvider = 'url';

    this.totalSize = 50 * 1000 * 1000;
    this.loadingStarted = false;
    this.refreshPage = false;
    // remote location of devtools we're using
    this.devtoolsBase = document.getElementById('devtoolsscript').src.replace(/inspector\.js.*/, '');

    this.statusElem = document.getElementById('status');

    this.utils = new Utils();
    this.devTools = new DevTools({viewerInstance: this});

    this.driveAssetLoaded = new Promise((resolve, reject) => {
      this.driveAssetLoadedResolver = resolve;
    });
    this.iframeAssetLoaded = new Promise((resolve, reject) => {
      this.iframeAssetLoadedResolver = resolve;
    });

    this.parseURLforTimelineId(this.timelineURL);

    if (!this.timelineURL || this.startSplitViewIfNeeded(this.timelineURL)) {
      this.splitViewContainer = document.getElementById('split-view-container');
      this.isSplitView = this.splitViewContainer ? true : false;
      this.handleDragEvents();
    }

    // Start loading DevTools. (checkAuth will be racing against it)
    this.statusElem.hidden = false;

    this.devTools.init();

    this.requestIframeDataMeta();
  }

  handleDragEvents() {
    const dropboxEl = document.getElementById('dropbox');
    if (dropboxEl) {
      dropboxEl.addEventListener('dragover', this.dragover.bind(this), false);
    }
  }

  toggleUploadToDriveElem(display) {
    this.uploadToDriveElem.hidden = !display;
  }

  dragover(e) {
    e.stopPropagation();
    e.preventDefault();
    // we fair that all timeline resources are uploaded
    UI.inspectorView.showPanel('timeline');
  }


  parseURLforTimelineId(url) {
    try {
      const parsedURL = new URL(url);
      if (parsedURL.protocol === 'iframe:') {
        this.timelineProvider = 'iframe';
        this.timelineId = parsedURL.pathname.replace(/^\/+/, '');
      }
    } catch (e) {
      // legacy URLs, without a drive:// prefix.
      this.timelineId = url;
      this.timelineProvider = 'iframe';
    }
  }

  startSplitViewIfNeeded(urls) {
    urls = urls.split(',');

    if (urls.length > 1) {
      const frameset = document.createElement('frameset');
      frameset.setAttribute('id', 'split-view-container');
      frameset.setAttribute('rows', new Array(urls.length).fill(`${100/2}%`).join(','));

      urls.forEach((url, index) => {
        const frame = document.createElement('frame');
        frame.setAttribute('id', `split-view-${index}`);
        frame.setAttribute('src', `./?loadTimelineFromURL=${url.trim()}`);
        frameset.appendChild(frame);
      });
      document.body.appendChild(frameset);
      document.documentElement.classList.add('fullbleed');
      document.querySelector('.welcome').remove();
      document.querySelector('.top-message-container').remove();
      return true;
    }
    return false;
  }

  updateStatus(str) {
    if (this.timelineProvider === 'iframe') {
      window.postMessage(JSON.stringify({
        type: 'message_status',
        data: str,
      }), '*');
    } else {
      this.statusElem.textContent = str;
    }
  }

  loadResource(requestedURL) {
    return this.loadResourcePromise(requestedURL)
      .then(resp => {
        this.devTools.monkeyPatchingHandleDrop();
        return resp;
      });
  }

  // monkeypatched method for devtools
  loadResourcePromise(requestedURL) {
    const url = new URL(requestedURL, location.href);
    const URLofViewer = new URL(location.href);

    // hosted devtools gets confused
    // if DevTools is requesting a file thats on our origin, we'll redirect it to devtoolsBase
    if (url && url.origin === URLofViewer.origin && (requestedURL !== this.timelineURL)) {
      const relativeurl = url.pathname.replace(URLofViewer.pathname, '').replace(/^\//, '');
      const redirectedURL = new URL(relativeurl, this.devtoolsBase);
      return this._orig_loadResourcePromise(redirectedURL.toString());
    }

    if (this.timelineProvider === 'iframe') {
      return this.iframeAssetLoaded.then(payload => payload);
    }

    // pass through URLs that aren't our timelineURL param
    if (requestedURL !== this.timelineURL) {
      return this._orig_loadResourcePromise(url);
    }

    // adjustments for CORS
    url.hostname = url.hostname.replace('github.com', 'githubusercontent.com');
    url.hostname = url.hostname.replace('www.dropbox.com', 'dl.dropboxusercontent.com');

    return this.fetchTimelineAsset(url.href).then(payload => payload);
  }

  requestIframeDataMeta() {
    if (this.timelineProvider !== 'iframe') return;
    // if there's no this.timelineId then let's skip all this drive API stuff.
    if (!this.timelineId) return;

    window.addEventListener('message', (event) => {
      try {
        const {type, data} = JSON.parse(event.data);
        if (type === 'message_timeline') {
          this.updateStatus('Starting download of timeline from iframe. Please wait...');

          this.iframeAssetLoadedResolver(data);
        }
      } catch (err) {
      }
    }, false);
  }

  fetchTimelineAsset(url, addRequestHeaders = Function.prototype, method = 'GET', body) {
    this.netReqMuted = false;
    this.loadingStarted = false;
    return this.utils.fetch(url, {
      url, addRequestHeaders: addRequestHeaders.bind(this), method, body,
      onprogress: this.updateProgress.bind(this),
    }, true)
      .then(xhr => {
        if (this.isSplitView) {
          return this.syncView.splitViewTimelineLoaded()
            .then(_ => SyncView.synchronizeRange(SyncView.panels()[0], this.syncView))
            .then(_ => xhr.responseText);
        } else {
          return xhr.responseText;
        }
      })
      .catch(({error, xhr}) => {
        this.updateStatus('Download of asset failed. ' + ((xhr.readyState == xhr.DONE) ? 'CORS headers likely not applied.' : ''));
        console.warn('Download of asset failed', error);
      });
  }

  setAuthHeaders(xhr) {
    xhr.setRequestHeader('Authorization', `Bearer ${GoogleAuth.getUserAccessToken()}`);
  }

  updateProgress(evt) {
    try {
      this.updateStatus(`Download progress: ${((evt.loaded / this.totalSize) * 100).toFixed(2)}%`);

      UI.inspectorView.showPanel('timeline').then(_ => {
        const panel = Timeline.TimelinePanel.instance();
        // start progress
        if (!this.loadingStarted) {
          this.loadingStarted = true;
          panel && panel.loadingStarted();
        }

        // update progress
        panel && panel.loadingProgress(evt.loaded / (evt.total || this.totalSize));

        // flip off filmstrip or network if theres no data in the trace
        if (!this.netReqMuted) {
          this.netReqMuted = true;
          this.devTools.monkepatchSetMarkers();
        }
      });
    } catch (e) {}
  }

  changeUrl(id) {
    const url = `?loadTimelineFromURL=drive://${id}`;
    if (this.refreshPage) {
      window.location.href = `/${url}`;
    } else {
      const state = {'file_id': id};
      const title = 'Timeline Viewer';
      history.replaceState(state, title, url);
    }
  }
}
