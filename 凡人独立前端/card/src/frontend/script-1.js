
      (function () {
        try {
          var noop = function () {};
          if (window.performance) {
            window.performance.mark = noop;
            window.performance.measure = noop;
            // 清理已有的缓存
            if (window.performance.clearMarks) window.performance.clearMarks();
            if (window.performance.clearMeasures) window.performance.clearMeasures();
          }
          console.log('已拦截 Performance API，防止内存泄漏。');
        } catch (e) {
          /* 忽略错误 */
        }
      })();

// Independent from the large main script: a parse/load error must be visible on the splash.
(function () {
  var state = { phase: '等待主脚本', complete: false, error: '' };
  window.frStartupStatus = state;
  function render() {
    var node = document.getElementById('fr-startup-status');
    if (!node) return;
    node.textContent = state.phase + (state.error ? ' · 启动未完成：' + state.error : '');
    node.style.color = state.error ? '#ffb4a9' : '#ddd';
  }
  window.frReportStartupPhase = function (phase, complete) {
    state.phase = phase;
    state.complete = !!complete;
    render();
  };
  window.frReportStartupError = function (error) {
    if (!state.error) state.error = String(error && error.message ? error.message : error || '未知错误').slice(0, 400);
    render();
  };
  window.addEventListener('error', function (event) {
    if (!state.complete && event.message) window.frReportStartupError(event.error || event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    if (!state.complete) window.frReportStartupError(event.reason);
  });
  document.addEventListener('DOMContentLoaded', render, { once: true });
})();
    
