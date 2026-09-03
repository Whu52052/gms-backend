/**
 * js/status-pages-common.js
 * Shared utility functions for public status query pages:
 *   - location-status.html
 *   - machine-status.html
 *   - sn-status.html
 *
 * MUST be loaded before each page's inline <script>.
 */
(function() {
  'use strict';

  window.StatusPageUtils = {

    /**
     * Escape HTML special characters to prevent XSS.
     */
    escapeHtml: function(s) {
      if (s == null) return '';
      return String(s).replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      });
    },

    /**
     * Format an ISO timestamp to a short zh-CN locale string.
     */
    formatTime: function(t) {
      if (!t) return '\u2014'; // em dash
      try {
        return new Date(t).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        });
      } catch (e) { return t; }
    },

    /**
     * Show a centered toast notification.
     * @param {string} msg - text to display
     * @param {number} [duration=2200] - milliseconds to show
     */
    showToast: function(msg, duration) {
      var el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(function() { el.classList.remove('show'); }, duration || 2200);
    },

    /**
     * Simple fetch wrapper that returns parsed JSON.
     */
    fetchData: function(url) {
      return fetch(url)
        .then(function(res) { return res.json(); })
        .catch(function() { return { error: '\u7f51\u7edc\u9519\u8bef' }; });
    },
  };

})();
