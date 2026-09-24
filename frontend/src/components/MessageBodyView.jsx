import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { measureContentHeight, createHeightController, forceEagerImages } from '../utils/emailFrameHeight.js';
import { decideMailDark, detectsNativeDark, frameSrcDoc } from '../utils/mailDarkMode.js';

// The email body, rendered in its own sandboxed frame.
//
// Extracted from MessagePane so a conversation view can mount one per expanded message
// (#316). Only expanded messages render a body; a collapsed message is a header and costs
// nothing, which is what keeps a long thread affordable when each body is a whole document.
//
// The frame node is forwarded rather than owned. MessagePane reaches into it for five
// separate things (selection, find-in-message, the context menu, positioning, resetting
// height between messages) and forwarding leaves every one of those untouched.
//
// The experimental div renderer (VITE_EMAIL_DIV_RENDER) is deliberately NOT here: it is off
// by default and untested, and moving it would double the size of this change.
//
// `darkMode` asks for smart dark mode (utils/mailDarkMode.js): the frame is decided native,
// already dark or inverted once it has parsed, and again after its first height settles, and
// `onDarkMode(mode)` hears the answer. Off, the frame is the white page it has always been.
function MessageBodyView({ body, messageId, emailScaleRef, hasNativeContextTarget, onContextMenu, iframeRef, darkMode = false, onDarkMode = null }) {
  const { t } = useTranslation();
  const html = body?.html;
  const native = useMemo(() => Boolean(darkMode) && detectsNativeDark(html), [darkMode, html]);
  const srcDoc = useMemo(() => frameSrcDoc(html, { dark: Boolean(darkMode), native }), [html, darkMode, native]);
  // The callback is read at decision time, so a new function each render does not re-run the effect.
  const onDarkModeRef = useRef(onDarkMode);
  useEffect(() => { onDarkModeRef.current = onDarkMode; }, [onDarkMode]);
  // Holds the ResizeObserver watching the frame's document, so the effect can disconnect the
  // previous one before observing a new document.
  const roRef = useRef(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !body?.html) return;

    let rafId;
    let pollId = null;
    const heights = createHeightController();
    let initialisedDoc = null;
    let contextMenuDoc = null;
    let iframeContextMenuHandler = null;
    let clickDoc = null;
    let iframeClickHandler = null;

    // Smart dark mode: decide on OUR document only, and never in light mode.
    const runDark = () => {
      if (!darkMode) return;
      const doc = iframe.contentDocument;
      if (!doc || doc !== initialisedDoc) return;
      const mode = decideMailDark(doc, { native });
      if (mode) onDarkModeRef.current?.(mode);
    };

    const setHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const b = doc.body;
      const wrapper = doc.getElementById('mf-scale-wrapper');
      // documentElement is deliberately NOT measured: its scrollHeight is floored by
      // the frame's own viewport, so once the frame is N tall every reading is >= N
      // and an over-estimate can never be walked back. That floor, not the guard that
      // used to sit below it, is what left whitespace under short emails.
      const h = measureContentHeight({
        wrapperOffsetHeight: wrapper ? wrapper.offsetHeight : 0,
        wrapperOffsetTop:    wrapper ? wrapper.offsetTop    : 0,
        bodyScrollHeight:    b ? b.scrollHeight : 0,
        bodyOffsetHeight:    b ? b.offsetHeight : 0,
      });
      // Scale visual height to match the proportional scale applied to the
      // email wrapper (1 for normal emails, <1 for wide fixed-layout emails).
      // offsetHeight above is untransformed, so the factor applies exactly once.
      const next = heights.next(h, emailScaleRef.current);
      if (next !== null) iframe.style.height = next + 'px';
    };

    const onLoaded = () => {
      const doc = iframe.contentDocument;
      // Only ever initialise against OUR document. A freshly mounted frame exposes an
      // about:blank whose readyState is already 'complete', and a frame whose srcDoc has
      // just changed still exposes the PREVIOUS email until the swap lands. Either way the
      // readyState fast path further down can fire against a document that is not this
      // email, measuring it and binding a ResizeObserver to it. #mf-scale-wrapper is only
      // present in a document we rendered, which makes it a reliable marker.
      if (!doc || !doc.getElementById('mf-scale-wrapper')) return;
      // The same for a dark-mode flip, which swaps in a document of the other kind: only the
      // dark document carries data-hw-dark on its root.
      if (Boolean(darkMode) !== Boolean(doc.documentElement?.hasAttribute('data-hw-dark'))) return;
      // Guard the fast path against re-running on a document already wired up. This is
      // per effect run, so a genuine re-run (changed deps) still re-attaches everything
      // the cleanup tore down.
      if (doc === initialisedDoc) return;
      initialisedDoc = doc;

      emailScaleRef.current = 1; // reset for each new email

      // Start every image fetching now, rather than letting the browser defer them.
      //
      // Lazy loading is gated on the scroll viewport, and for an iframe that viewport is
      // the frame's own box, which starts at 300px. Images below that never fetch, so they
      // measure as zero height, so the frame is sized short, which brings the next image
      // into range, which fetches, which grows the content, which resizes the frame again.
      // Every step of that staircase costs a network round trip, and a marketing email with
      // nine stacked images renders in visible instalments. Looking at it mid-staircase is
      // the "half loaded" email; it only appears fixed on a second visit because the images
      // are cached by then.
      //
      // Nothing is lost by loading eagerly: the frame has no internal scrolling and is
      // sized to its full content, so every image ends up on screen regardless.
      //
      // Done against the DOM rather than by rewriting the srcDoc HTML so there is no chance
      // of matching the attribute inside text content. Flipping here, before the load
      // handlers further down are attached, is safe because everything between is
      // synchronous: a fetch cannot deliver its load event until this function yields, by
      // which point the handlers exist. The ResizeObserver on the body is the backstop
      // regardless.
      forceEagerImages(doc);

      // Some marketing emails have inline styles on their <body> tag (e.g. overflow:auto,
      // height:100%) that the HTML parser merges into the iframe's outer <body>.  Our
      // injected <style> with !important can't win against inline !important rules.
      // Setting the properties via JS style.setProperty(...,'important') writes them as
      // inline !important, which always beats any same-property inline value from the email.
      const b = doc.body;
      const h = doc.documentElement;
      if (b) {
        b.style.setProperty('height', 'auto', 'important');
        b.style.setProperty('min-height', '0', 'important');
        b.style.setProperty('overflow-y', 'hidden', 'important');
      }
      if (h) {
        h.style.setProperty('height', 'auto', 'important');
        h.style.setProperty('min-height', '0', 'important');
        h.style.setProperty('overflow-y', 'hidden', 'important');
      }

      // Some marketing emails (e.g. Avis) use class-based !important rules that
      // lock layout to a fixed pixel width and cannot be overridden by our injected
      // CSS. Measure the rendered content width and, if it exceeds the iframe,
      // scale the entire wrapper div down proportionally so all content is visible.
      const iframeW = iframe.offsetWidth;
      if (iframeW > 0) {
        // iOS Safari clamps scrollWidth to the iframe viewport when overflow:hidden
        // is set on html/body, so wide fixed-layout emails are never detected.
        // Temporarily expose overflow-x inline (beating the !important stylesheet
        // rule) to let scrollWidth reflect the true content width, then restore.
        // Note: overflow-x:visible is coerced to auto when overflow-y is non-visible —
        // that's fine; auto still returns the real scrollable content width.
        if (b) b.style.setProperty('overflow-x', 'visible', 'important');
        if (h) h.style.setProperty('overflow-x', 'visible', 'important');
        const contentW = Math.max(
          h ? h.scrollWidth : 0,
          b ? b.scrollWidth : 0,
        );
        if (b) b.style.removeProperty('overflow-x');
        if (h) h.style.removeProperty('overflow-x');

        const wrapper = doc.getElementById('mf-scale-wrapper');
        if (contentW > iframeW + 2) { // +2 absorbs sub-pixel rounding
          const scale = iframeW / contentW;
          emailScaleRef.current = scale;
          if (wrapper) {
            wrapper.style.transform       = `scale(${scale})`;
            wrapper.style.transformOrigin = 'top left';
            // Lock the wrapper at its natural content width so the scale
            // maps exactly contentW → iframeW with no clipping.
            wrapper.style.width           = `${contentW}px`;
          }
        }
      }

      // Expand any nested scroll containers so their full content is visible
      // without internal scrolling. Marketing emails sometimes apply overflow:auto
      // plus a fixed height to inner divs/tds, which makes iOS scroll that element
      // instead of the outer pane container — leaving the sender card pinned like a
      // sticky header.
      //
      // Process in REVERSE document order (deepest elements first) so that when we
      // expand an inner scroll container, the outer container's scrollHeight already
      // reflects the expanded child when we evaluate it — preventing missed outer
      // containers in a single pass.
      //
      // expandedEls tracks which elements we've already expanded so that subsequent
      // calls from image load handlers can re-check and grow them as lazy images add
      // height (an element that was 1 000 px after the first pass may be 3 000 px
      // once all images are loaded).
      const expandedEls = new Set();
      const dv = doc.defaultView;
      const expandScrollContainers = () => {
        if (!dv) return;
        Array.from(doc.querySelectorAll('*')).reverse().forEach(el => {
          const cs = dv.getComputedStyle(el);
          const oy = cs.overflowY;
          const isScrollContainer = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
          const grewAfterExpansion = expandedEls.has(el) && el.scrollHeight > el.clientHeight + 2;
          if (isScrollContainer || grewAfterExpansion) {
            expandedEls.add(el);
            el.style.setProperty('overflow-y', 'hidden', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('height', el.scrollHeight + 'px', 'important');
          }
        });
      };
      expandScrollContainers();

      // Decide dark mode now that the layout (and any scale-to-fit) is in place. Backgrounds
      // are all a decision reads, and lazy images never change them, so this and one more run
      // after the first height settle below are enough.
      runDark();

      // Recalculate from scratch with the new scale. The controller deliberately does
      // not seed itself from the frame's current height, so this measurement is
      // authoritative even when it is SHORTER than what is currently applied. That is
      // what clears leftover whitespace when the previous email was taller.
      heights.reset();
      setHeight();
      rafId = requestAnimationFrame(() => { setHeight(); runDark(); });

      // Intercept all link clicks so they always open in a real browser tab.
      // Without this, relative hrefs (e.g. href="/") resolve to the mailflow
      // origin via allow-same-origin and open a new mailflow tab instead of
      // the intended destination.  We read the raw attribute to bypass
      // browser resolution and only forward absolute http(s)/mailto links.
      // Tracked and removed like the contextmenu handler below — onLoaded can
      // re-run on the same document when the effect's callback deps change,
      // and an untracked listener stacks up, opening N duplicate tabs per click.
      if (clickDoc && iframeClickHandler) {
        clickDoc.removeEventListener('click', iframeClickHandler);
      }
      iframeClickHandler = (ev) => {
        const anchor = ev.target.closest('a[href]');
        if (!anchor) return;
        ev.preventDefault();
        let raw = anchor.getAttribute('href') || '';
        if (raw.startsWith('//')) raw = 'https:' + raw;
        if (/^https?:\/\//i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        } else if (/^mailto:/i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        }
      };
      clickDoc = doc;
      doc.addEventListener('click', iframeClickHandler);

      if (contextMenuDoc && iframeContextMenuHandler) {
        contextMenuDoc.removeEventListener('contextmenu', iframeContextMenuHandler);
      }
      iframeContextMenuHandler = (ev) => {
        if (hasNativeContextTarget(ev, doc)) return;
        ev.preventDefault();
        const rect = iframe.getBoundingClientRect();
        onContextMenu(rect.left + ev.clientX, rect.top + ev.clientY, {
          source: 'iframe',
          selectedText: doc.getSelection?.().toString() || '',
        });
      };
      contextMenuDoc = doc;
      doc.addEventListener('contextmenu', iframeContextMenuHandler);

      // Re-measure after each lazy-loaded image settles; also re-expand any
      // scroll containers whose content has grown due to the newly loaded image.
      doc.querySelectorAll('img').forEach(img => {
        if (!img.complete) {
          img.addEventListener('load', () => { expandScrollContainers(); requestAnimationFrame(setHeight); }, { once: true });
          img.addEventListener('error', () => requestAnimationFrame(setHeight), { once: true });
        }
      });

      // Watch for content that reflows after load (web fonts, dynamic content).
      // Shrinking is allowed here: content height cannot depend on frame height,
      // because html/body are pinned to height:auto above and media queries key off
      // width. createHeightController still carries a tolerance band plus an
      // oscillation freeze in case some email defeats that reasoning.
      const root = doc.body || doc.documentElement;
      if (window.ResizeObserver && root) {
        // Disconnect first: onLoaded can legitimately run more than once per effect
        // (stale document, then the real one), and overwriting the ref without this
        // leaves the previous observer running against the old document forever.
        if (roRef.current) roRef.current.disconnect();
        roRef.current = new ResizeObserver(() => requestAnimationFrame(setHeight));
        roRef.current.observe(root);
      }
    };

    // 'load' is kept, but it CANNOT be the only trigger. It waits for every subresource,
    // so a single image that never settles (a dead tracking pixel, a blocked host, a host
    // that accepts the connection and never answers) leaves the document parked at
    // readyState 'interactive' forever. load never fires, none of the setup above ever
    // runs, and the frame sits at its initial 300px with the email clipped inside it. One
    // unreachable image was enough to break rendering of the whole message.
    //
    // Not { once: true } either: a frame fires 'load' for the about:blank it starts life
    // with, and a once-listener is spent on that even though onLoaded correctly declines
    // to initialise against a document that is not ours.
    iframe.addEventListener('load', onLoaded);

    // Everything onLoaded does needs only a parsed DOM, never a finished one, so drive it
    // from the parsed state and let the image handlers and the ResizeObserver grow the
    // frame as pictures arrive. Polling by frame rather than listening for
    // DOMContentLoaded because the document to listen on does not exist yet at this point:
    // the frame is still showing about:blank and swaps in the real one later. onLoaded is
    // idempotent per document, so the repeated calls are free and stop as soon as one
    // succeeds.
    let pollFrames = 0;
    const MAX_POLL_FRAMES = 300; // ~5s at 60fps; srcDoc parses far sooner
    const pollUntilParsed = () => {
      pollId = null;
      onLoaded();
      if (initialisedDoc || pollFrames++ >= MAX_POLL_FRAMES) return;
      pollId = requestAnimationFrame(pollUntilParsed);
    };
    pollUntilParsed();

    return () => {
      cancelAnimationFrame(rafId);
      if (pollId) cancelAnimationFrame(pollId);
      if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
      if (contextMenuDoc && iframeContextMenuHandler) {
        contextMenuDoc.removeEventListener('contextmenu', iframeContextMenuHandler);
      }
      if (clickDoc && iframeClickHandler) {
        clickDoc.removeEventListener('click', iframeClickHandler);
      }
      iframe.removeEventListener('load', onLoaded);
      emailScaleRef.current = 1;
    };
  }, [body?.html, messageId, hasNativeContextTarget, onContextMenu, emailScaleRef, iframeRef, darkMode, native]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      scrolling="no"
      style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px', ...(darkMode ? { colorScheme: 'dark' } : null) }}
      data-hw-dark-frame={darkMode ? (native ? 'native' : 'smart') : undefined}
      referrerPolicy="no-referrer"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={t('message.emailFrameTitle')}
    />
  );
}

export default MessageBodyView;
