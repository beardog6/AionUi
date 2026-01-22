/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useTypingAnimation } from '@/renderer/hooks/useTypingAnimation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateInspectScript } from './htmlInspectScript';
import { useScrollSyncTarget } from '../../hooks/useScrollSyncHelpers';

/** 选中元素的数据结构 / Selected element data structure */
export interface InspectedElement {
  /** 完整 HTML / Full HTML */
  html: string;
  /** 简化标签名 / Simplified tag name */
  tag: string;
}

interface HTMLRendererProps {
  content: string;
  filePath?: string;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (scrollTop: number, scrollHeight: number, clientHeight: number) => void;
  inspectMode?: boolean; // 是否开启检查模式 / Whether inspect mode is enabled
  copySuccessMessage?: string;
  /** 元素选中回调 / Element selected callback */
  onElementSelected?: (element: InspectedElement) => void;
}

// Electron webview 元素的类型定义 / Type definition for Electron webview element
interface ElectronWebView extends HTMLElement {
  src: string;
  executeJavaScript: (code: string) => Promise<void>;
}

/**
 * HTML 渲染器组件
 * HTML renderer component
 *
 * 在 webview 中渲染 HTML 内容（Electron 专用标签）
 * Renders HTML content in a webview (Electron-specific tag)
 */
const HTMLRenderer: React.FC<HTMLRendererProps> = ({ content, filePath, containerRef, onScroll, inspectMode = false, copySuccessMessage, onElementSelected }) => {
  const divRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<ElectronWebView | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const webviewLoadedRef = useRef(false); // 跟踪 webview 是否已加载 / Track if webview is loaded
  const isSyncingScrollRef = useRef(false); // 防止滚动同步循环 / Prevent scroll sync loops
  const [webviewContentHeight, setWebviewContentHeight] = useState(0); // webview 内容高度 / webview content height
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });

  // detect if running inside Electron (renderer). Fallback to iframe in browsers/webui.
  const isElectron = useMemo(() => {
    try {
      if (typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)) return true;
      // window.process?.type is often present in Electron renderer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (w && w.process && w.process.type === 'renderer') return true;
    } catch (e) {}
    return false;
  }, []);

  // 监听主题变化 / Monitor theme changes
  useEffect(() => {
    const updateTheme = () => {
      const theme = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
      setCurrentTheme(theme);
    };

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  // 判断是否应该直接从文件加载（支持相对资源）
  const shouldLoadFromFile = useMemo(() => {
    if (!filePath) return false;
    // 检查 HTML 是否引用了相对资源 / Check if HTML references relative resources
    const hasRelativeResources = /<link[^>]+href=["'](?!https?:\/\/|data:|\/\/)[^"']+["']/i.test(content) || /<script[^>]+src=["'](?!https?:\/\/|data:|\/\/)[^"']+["']/i.test(content) || /<img[^>]+src=["'](?!https?:\/\/|data:|\/\/)[^"']+["']/i.test(content);
    return hasRelativeResources;
  }, [content, filePath]);

  // 流式打字动画：HTML 预览在使用 data URL 渲染时也能获得流式体验
  // Typing animation: provide streaming experience when rendering via data URL
  const { displayedContent } = useTypingAnimation({
    content,
    enabled: !shouldLoadFromFile,
    speed: 40,
  });

  const htmlContent = useMemo(() => (shouldLoadFromFile ? content : displayedContent), [shouldLoadFromFile, content, displayedContent]);

  // helper: inject <base> tag for relative paths
  const injectBaseIfNeeded = (html: string, baseUrl: string) => {
    if (!html.match(/<base\s+href=/i)) {
      if (html.match(/<head>/i)) {
        return html.replace(/<head>/i, `<head><base href="${baseUrl}">`);
      } else if (html.match(/<html>/i)) {
        return html.replace(/<html>/i, `<html><head><base href="${baseUrl}"></head>`);
      } else {
        return `<head><base href="${baseUrl}"></head>${html}`;
      }
    }
    return html;
  };

  // 计算 webview/iframe 的 src
  // Calculate webview/iframe src
  const rendererSrc = useMemo(() => {
    // If should load from file and we have a filePath, prefer file:// in Electron
    if (shouldLoadFromFile && filePath) {
      if (isElectron) {
        return `file://${filePath}`;
      }
      // In browser/webui: file:// cannot be loaded. We will construct a data/blob URL from the HTML content
      // and inject a base that points to a proxy endpoint for serving relative resources.
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
      // Proxy endpoint used when running in webui — requires a small server-side proxy to serve file:// resources.
      const proxyBase = `/__aionui_file_proxy__?dir=${encodeURIComponent(fileDir)}`;
      const htmlWithBase = injectBaseIfNeeded(htmlContent, proxyBase);
      const encoded = encodeURIComponent(htmlWithBase);
      return `data:text/html;charset=utf-8,${encoded}`;
    }

    // Otherwise use data URL (suitable for generated HTML or when no external resources are needed)
    let html = htmlContent;

    if (filePath) {
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
      // For browser, if filePath looks like an http(s) URL, use it as base; otherwise use a proxy base if needed
      let baseUrl = '';
      if (/^https?:\/\//i.test(fileDir)) {
        baseUrl = fileDir;
      } else if (isElectron) {
        baseUrl = `file://${fileDir}`;
      } else {
        baseUrl = `/__aionui_file_proxy__?dir=${encodeURIComponent(fileDir)}`; // requires server proxy in webui mode
      }

      if (!html.match(/<base\s+href=/i)) {
        if (html.match(/<head>/i)) {
          html = html.replace(/<head>/i, `<head><base href="${baseUrl}">`);
        } else if (html.match(/<html>/i)) {
          html = html.replace(/<html>/i, `<html><head><base href="${baseUrl}"></head>`);
        } else {
          html = `<head><base href="${baseUrl}"></head>${html}`;
        }
      }
    }

    const encoded = encodeURIComponent(html);
    return `data:text/html;charset=utf-8,${encoded}`;
  }, [htmlContent, filePath, shouldLoadFromFile, isElectron]);

  // 当 rendererSrc 改变时重置加载状态 / Reset loading state when src changes
  useEffect(() => {
    webviewLoadedRef.current = false;
  }, [rendererSrc]);

  // For Electron webview: listen did-finish-load / did-fail-load
  useEffect(() => {
    if (!isElectron) return;
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDidFinishLoad = () => {
      webviewLoadedRef.current = true; // 标记为已加载 / Mark as loaded
    };

    const handleDidFailLoad = (_event: Event) => {
      // Handle webview load failure (no-op)
    };

    webview.addEventListener('did-finish-load', handleDidFinishLoad);
    webview.addEventListener('did-fail-load', handleDidFailLoad);

    return () => {
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
      webview.removeEventListener('did-fail-load', handleDidFailLoad);
    };
  }, [rendererSrc, isElectron]);

  // Generate inspect script
  const copySuccessText = useMemo(() => copySuccessMessage ?? '✓ Copied HTML snippet', [copySuccessMessage]);
  const inspectScript = useMemo(() => generateInspectScript(inspectMode, { copySuccess: copySuccessText }), [inspectMode, copySuccessText]);

  // Execute script helper for Electron webview
  const executeScriptOnWebview = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    void webview.executeJavaScript(inspectScript).catch(() => {});
  }, [inspectScript]);

  // Execute script helper for iframe (browser)
  const executeScriptOnIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const win = iframe.contentWindow;
      if (!win) return;
      // inject inspect script directly into iframe
      // First, make console.log inside iframe also post messages to parent so we can observe messages similarly to webview's console-message
      const bridge = `
        (function(){
          try{
            const _log = console.log.bind(console);
            console.log = function(){
              try{ window.parent.postMessage({ __aionui_console: Array.from(arguments).join(' ') }, '*'); }catch(e){}
              _log.apply(console, arguments);
            };
          }catch(e){}
        })();
      `;
      // run bridge + inspect script
      win.eval(bridge + '\n' + inspectScript);
    } catch (e) {
      // ignore cross-origin errors
    }
  }, [inspectScript]);

  // Inject inspect script after load
  useEffect(() => {
    if (isElectron) {
      const webview = webviewRef.current;
      if (!webview) return;

      if (webviewLoadedRef.current) {
        executeScriptOnWebview();
      }

      const handleLoad = () => executeScriptOnWebview();
      webview.addEventListener('did-finish-load', handleLoad);
      return () => webview.removeEventListener('did-finish-load', handleLoad);
    }

    // iframe path
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      webviewLoadedRef.current = true;
      executeScriptOnIframe();
    };

    iframe.addEventListener('load', handleLoad);
    return () => iframe.removeEventListener('load', handleLoad);
  }, [executeScriptOnIframe, executeScriptOnWebview, isElectron]);

  // Listen for messages from either webview console (Electron) or iframe postMessage (browser)
  useEffect(() => {
    if (isElectron) {
      const webview = webviewRef.current;
      if (!webview) return;

      const handleConsoleMessage = (event: Event) => {
        const consoleEvent = event as Event & { message?: string };
        const message = consoleEvent.message;

        if (typeof message === 'string') {
          if (message.startsWith('__INSPECT_ELEMENT__') && onElementSelected) {
            try {
              const jsonStr = message.slice('__INSPECT_ELEMENT__'.length);
              const data = JSON.parse(jsonStr) as InspectedElement;
              onElementSelected(data);
            } catch (e) {
              console.warn('[HTMLRenderer] Failed to parse inspect element message:', e);
            }
          } else if (message.startsWith('__SCROLL_SYNC__') && onScroll) {
            if (isSyncingScrollRef.current) return;
            try {
              const jsonStr = message.slice('__SCROLL_SYNC__'.length);
              const data = JSON.parse(jsonStr) as { scrollTop: number; scrollHeight: number; clientHeight: number };
              onScroll(data.scrollTop, data.scrollHeight, data.clientHeight);
            } catch (e) {
              console.warn('[HTMLRenderer] Failed to parse scroll message:', e);
            }
          } else if (message.startsWith('__CONTENT_HEIGHT__')) {
            try {
              const height = parseInt(message.slice('__CONTENT_HEIGHT__'.length), 10);
              if (!isNaN(height) && height > 0) setWebviewContentHeight(height);
            } catch (e) {}
          }
        }
      };

      webview.addEventListener('console-message', handleConsoleMessage);
      return () => webview.removeEventListener('console-message', handleConsoleMessage);
    }

    // Browser: listen to postMessage from iframe bridge
    const handleMessage = (ev: MessageEvent) => {
      const data = ev.data as any;
      if (!data) return;
      if (typeof data === 'string' && data.startsWith('__')) {
        // legacy string messages
        const message = data as string;
        if (message.startsWith('__INSPECT_ELEMENT__') && onElementSelected) {
          try {
            const jsonStr = message.slice('__INSPECT_ELEMENT__'.length);
            const parsed = JSON.parse(jsonStr) as InspectedElement;
            onElementSelected(parsed);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse inspect element message:', e);
          }
        } else if (message.startsWith('__SCROLL_SYNC__') && onScroll) {
          if (isSyncingScrollRef.current) return;
          try {
            const jsonStr = message.slice('__SCROLL_SYNC__'.length);
            const parsed = JSON.parse(jsonStr) as { scrollTop: number; scrollHeight: number; clientHeight: number };
            onScroll(parsed.scrollTop, parsed.scrollHeight, parsed.clientHeight);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse scroll message:', e);
          }
        } else if (message.startsWith('__CONTENT_HEIGHT__')) {
          try {
            const height = parseInt(message.slice('__CONTENT_HEIGHT__'.length), 10);
            if (!isNaN(height) && height > 0) setWebviewContentHeight(height);
          } catch (e) {}
        }
        return;
      }

      // structured messages from iframe bridge
      if (data.__aionui_console) {
        const message = String(data.__aionui_console || '');
        // reuse same parsing logic as console-message
        if (message.startsWith('__INSPECT_ELEMENT__') && onElementSelected) {
          try {
            const jsonStr = message.slice('__INSPECT_ELEMENT__'.length);
            const parsed = JSON.parse(jsonStr) as InspectedElement;
            onElementSelected(parsed);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse inspect element message:', e);
          }
        } else if (message.startsWith('__SCROLL_SYNC__') && onScroll) {
          if (isSyncingScrollRef.current) return;
          try {
            const jsonStr = message.slice('__SCROLL_SYNC__'.length);
            const parsed = JSON.parse(jsonStr) as { scrollTop: number; scrollHeight: number; clientHeight: number };
            onScroll(parsed.scrollTop, parsed.scrollHeight, parsed.clientHeight);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse scroll message:', e);
          }
        } else if (message.startsWith('__CONTENT_HEIGHT__')) {
          try {
            const height = parseInt(message.slice('__CONTENT_HEIGHT__'.length), 10);
            if (!isNaN(height) && height > 0) setWebviewContentHeight(height);
          } catch (e) {}
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isElectron, onElementSelected, onScroll]);

  // Inject scroll sync script (for webview via executeJavaScript, for iframe via eval injection performed in executeScriptOnIframe)
  const scrollSyncScript = useMemo(
    () => `
    (function() {
      if (window.__scrollSyncInitialized) return;
      window.__scrollSyncInitialized = true;

      // 发送内容高度 / Send content height
      function sendContentHeight() {
        const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        console.log('__CONTENT_HEIGHT__' + scrollHeight);
      }

      // 初始发送 / Initial send
      sendContentHeight();

      // 监听内容变化 / Listen for content changes
      const resizeObserver = new ResizeObserver(sendContentHeight);
      resizeObserver.observe(document.body);

      let scrollTimeout;
      window.addEventListener('scroll', function() {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(function() {
          const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
          const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          const clientHeight = window.innerHeight || document.documentElement.clientHeight;
          console.log('__SCROLL_SYNC__' + JSON.stringify({ scrollTop, scrollHeight, clientHeight }));
        }, 16); // ~60fps throttle
      }, { passive: true });
    })();
  `,
    []
  );

  useEffect(() => {
    if (isElectron) {
      const webview = webviewRef.current;
      if (!webview || !onScroll) return;

      const injectScrollSync = () => {
        void webview.executeJavaScript(scrollSyncScript).catch(() => {});
      };

      if (webviewLoadedRef.current) injectScrollSync();

      webview.addEventListener('did-finish-load', injectScrollSync);
      return () => webview.removeEventListener('did-finish-load', injectScrollSync);
    }

    // iframe path: inject via eval when iframe loads (handled in executeScriptOnIframe)
  }, [scrollSyncScript, onScroll, isElectron]);

  // 监听外部滚动同步请求 / Listen for external scroll sync requests
  const handleTargetScroll = useCallback((targetPercent: number) => {
    if (isElectron) {
      const webview = webviewRef.current;
      if (!webview || !webviewLoadedRef.current) return;

      void webview
        .executeJavaScript(
          `
          (function() {
            const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
            const clientHeight = window.innerHeight || document.documentElement.clientHeight;
            const targetScroll = ${targetPercent} * (scrollHeight - clientHeight);
            window.scrollTo({ top: targetScroll, behavior: 'auto' });
          })();
        `
        )
        .catch(() => {});
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe || !webviewLoadedRef.current) return;
    try {
      const win = iframe.contentWindow;
      if (!win) return;
      const script = `
        (function() {
          const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          const clientHeight = window.innerHeight || document.documentElement.clientHeight;
          const targetScroll = ${targetPercent} * (scrollHeight - clientHeight);
          window.scrollTo({ top: targetScroll, behavior: 'auto' });
        })();
      `;
      win.eval(script);
    } catch (e) {
      // ignore
    }
  }, [isElectron]);

  // 使用外部 containerRef 或内部 divRef / Use external containerRef or internal divRef
  const effectiveContainerRef = containerRef || divRef;
  useScrollSyncTarget(effectiveContainerRef, handleTargetScroll);

  // 监听容器滚动，同步到 webview/iframe / Listen to container scroll, sync to renderer
  useEffect(() => {
    const container = containerRef?.current || divRef.current;
    if (!container) return;

    const handleContainerScroll = () => {
      if (isSyncingScrollRef.current) return;

      if (isElectron) {
        const webview = webviewRef.current;
        if (!webview || !webviewLoadedRef.current) return;

        isSyncingScrollRef.current = true;
        const scrollPercentage = container.scrollTop / (container.scrollHeight - container.clientHeight || 1);

        void webview
          .executeJavaScript(
            `
            (function() {
              const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
              const clientHeight = window.innerHeight || document.documentElement.clientHeight;
              const targetScroll = ${scrollPercentage} * (scrollHeight - clientHeight);
              window.scrollTo({ top: targetScroll, behavior: 'auto' });
            })();
          `
          )
          .catch(() => {})
          .finally(() => {
            setTimeout(() => {
              isSyncingScrollRef.current = false;
            }, 50);
          });
        return;
      }

      // iframe path
      const iframe = iframeRef.current;
      if (!iframe || !webviewLoadedRef.current) return;

      isSyncingScrollRef.current = true;
      const scrollPercentage = container.scrollTop / (container.scrollHeight - container.clientHeight || 1);

      try {
        const win = iframe.contentWindow;
        if (!win) return;
        const script = `
          (function() {
            const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
            const clientHeight = window.innerHeight || document.documentElement.clientHeight;
            const targetScroll = ${scrollPercentage} * (scrollHeight - clientHeight);
            window.scrollTo({ top: targetScroll, behavior: 'auto' });
          })();
        `;
        win.eval(script);
      } catch (e) {
        // ignore
      } finally {
        setTimeout(() => {
          isSyncingScrollRef.current = false;
        }, 50);
      }
    };

    container.addEventListener('scroll', handleContainerScroll);
    return () => container.removeEventListener('scroll', handleContainerScroll);
  }, [containerRef, isElectron]);

  // 计算代理滚动层的高度 / Calculate proxy scroll layer height
  const proxyHeight = webviewContentHeight > 0 ? webviewContentHeight : '100%';

  return (
    <div ref={containerRef || divRef} className={`h-full w-full overflow-auto relative ${currentTheme === 'dark' ? 'bg-bg-1' : 'bg-white'}`}>\n      {/* 代理滚动层：使容器可滚动 / Proxy scroll layer: makes container scrollable */}    
      <div style={{ height: proxyHeight, width: '100%', pointerEvents: 'none' }} />
      {/* 渲染 Electron webview 或 browser iframe / Render Electron webview or browser iframe */}
      {isElectron ? (
        <webview
          key={rendererSrc}
          ref={webviewRef}
          src={rendererSrc}
          className='w-full border-0'
          style={{
            display: 'inline-flex',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            height: '100%',
          }}
          webpreferences='allowRunningInsecureContent, javascript=yes'
        />
      ) : (
        <iframe
          key={rendererSrc}
          ref={iframeRef}
          src={rendererSrc}
          className='w-full border-0'
          sandbox='allow-scripts allow-same-origin'
          style={{
            display: 'inline-flex',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            height: '100%',
            border: '0',
          }}
        />
      )}
    </div>
  );
};

export default HTMLRenderer;
