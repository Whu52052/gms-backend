/**
 * js/utils.js
 * Shared utility functions — consolidates duplicates previously scattered
 * across app.js, api.js, operations.js, ws-client.js, and storage.js.
 *
 * MUST be loaded before api.js / storage.js / app.js / operations.js / ws-client.js.
 */
(function() {
  'use strict';

  window.GMSUtils = {

    // ==================== COOKIE HELPERS ====================
    // Previously duplicated in:
    //   js/app.js       _setCookie / _getCookie / _deleteCookie  (lines 561-571)
    //   js/api.js       _setCookie / _getCookie                  (lines 650-658)
    //   js/operations.js _setCookie / _getCookie                 (lines 199-206)

    setCookie: function(name, value, days) {
      var d = new Date();
      d.setTime(d.getTime() + (days * 86400000));
      document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
    },

    getCookie: function(name) {
      var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
      return m ? decodeURIComponent(m[2]) : null;
    },

    deleteCookie: function(name) {
      document.cookie = name + '=;expires=Thu,01 Jan 1970 00:00:00 UTC;path=/';
    },

    // ==================== BUSINESS EVENT LIST ====================
    // Previously duplicated in:
    //   js/ws-client.js  WSClient._handleMessage  businessEvents  (lines 203-209)
    //   js/ws-client.js  SSEFallback.connect      events          (lines 337-345)
    //   js/api.js        _listenWS                 syncEvents      (lines 495-501)

    BUSINESS_EVENTS: [
      'inventory_updated', 'machines_updated', 'transactions_updated',
      'settings_updated', 'equipment_config_updated', 'inventory_config_updated',
      'users_updated', 'sn_registry_updated', 'tech_support_updated',
      'group_transfer_updated', 'ops_orders_updated', 'ops_customers_updated',
      'ops_production_updated', 'audit_log_updated', 'storage_locations_updated',
      'machine_presence_updated',
    ],

    // All SSE/WS events (business + realtime chat/user events)
    ALL_SYNC_EVENTS: [
      'tech:new_request', 'tech:responded', 'tech:completed',
      'data_changed', 'user:online', 'user:offline',
      'inventory_updated', 'machines_updated', 'tech_support_updated',
      'transactions_updated', 'users_updated', 'sn_registry_updated',
      'settings_updated', 'equipment_config_updated', 'inventory_config_updated',
      'group_transfer_updated', 'ops_orders_updated', 'ops_customers_updated',
      'ops_production_updated', 'audit_log_updated', 'storage_locations_updated',
      'chat:message', 'machine_bindings_updated', 'machine_presence_updated',
    ],

    // ==================== MACHINE MERGE HELPER ====================
    // Previously duplicated 3× in storage.js:
    //   _applyFullSyncData  (lines 737-754)
    //   _fullSyncFallback   (lines 796-817)
    //   _applySync          (lines 906-925)
    // All three used the same Map-based merge-by-machineNumber + updatedAt comparison.

    /**
     * Merge machine lists, keeping the latest record per machineNumber.
     * Comparison: updatedAt (desc), then id (desc) as tiebreaker.
     * @param {Array} lists - one or more arrays of machine objects
     * @returns {Array} merged, deduplicated machines
     */
    mergeMachines: function(lists) {
      var merged = new Map();
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li];
        if (!Array.isArray(list)) continue;
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || !item.machineNumber) continue;
          var existing = merged.get(item.machineNumber);
          if (!existing) { merged.set(item.machineNumber, item); continue; }
          var mTime = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
          var eTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
          if (mTime > eTime || (mTime === eTime && (item.id || '') > (existing.id || ''))) {
            merged.set(item.machineNumber, item);
          }
        }
      }
      return Array.from(merged.values());
    },

    // ==================== MOBILE DETECTION ====================
    // Previously duplicated as inline <script> in index.html and operations.html.

    isMobile: function() {
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
    },

    // ==================== ESCAPE HTML ====================
    // Previously duplicated in mobile.js (_esc) and various places.

    escapeHtml: function(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
  };

})();
