/* ============================================================
   宁狗在哪 · 小程序端 · v3.4
   - Flex 弹性布局 + 五档机型比例分类（mini / compact / regular / large / tablet）
   - 浅/深色统一 cover-image 水波纹图钉，采用呼吸间歇周期降低跨层通信耗电
   - 支持手动刷新、时间胶囊相对/绝对切换（本地记忆）、缩放边界态与轻触感反馈
   ============================================================ */
var APP = getApp();
var SERVER = APP.globalData.serverUrl;

var PULSE_MS = 170;             // 水波纹帧间隔，8 帧 ≈ 1.36 秒一轮
var PULSE_ROUNDS = 2;           // 每次呼吸连播 2 轮（约 2.7 秒）
var PULSE_REST_MS = 2400;       // 呼吸间歇静默 2.4 秒，大幅降低持续 setData 耗电
var REQUEST_TIMEOUT = 10000;    // 10 秒超时，避免弱网死等
var TIME_TICK_MS = 60000;       // 停留页面每分钟更新一次相对时间
var TIME_MODE_KEY = 'ninggou_time_mode';

var PULSE_FRAMES = [
  'marker-p0', 'marker-p1', 'marker-p2', 'marker-p3',
  'marker-p4', 'marker-p5', 'marker-p6', 'marker-p7'
];

var BJ_OFFSET = 8 * 3600 * 1000;
var DAY_LABELS = ['今天', '昨天', '前天'];

function bjMidnight(ms) {
  var d = new Date(ms + BJ_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/* 解析服务端 "YYYY-MM-DD HH:MM:SS" 为 UTC 毫秒（规避 iOS JSC 解析空格格式返回 Invalid Date） */
function parseTimestamp(ts) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts || ''));
  if (!m) return null;
  return {
    ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]),
    hhmm: m[4] + ':' + m[5]
  };
}

/* 绝对时间：今天 09:00 / 昨天 21:30 / 3 天前 08:15 */
function formatClockTime(parsed) {
  if (!parsed) return '';
  var days = Math.round((bjMidnight(Date.now()) - bjMidnight(parsed.ms)) / 86400000);
  if (days < 0) days = 0;
  var dayText = days < DAY_LABELS.length ? DAY_LABELS[days] : days + ' 天前';
  return dayText + ' ' + parsed.hhmm;
}

/* 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
function formatRelativeTime(parsed) {
  if (!parsed) return '';
  var diffMin = Math.floor((Date.now() - parsed.ms) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return diffMin + ' 分钟前';
  var diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + ' 小时前';
  var diffDay = Math.floor(diffHr / 24);
  return diffDay + ' 天前';
}

function hapticLight() {
  if (typeof wx.vibrateShort === 'function') {
    wx.vibrateShort({ type: 'light', fail: function () {} });
  }
}

Page({
  data: {
    loading: true,
    hasData: false,
    loadError: false,
    refreshing: false,
    topGap: 98,
    sizeClass: 'layout-regular',
    isIOS: false,
    latitude: 39.9042,          // 兜底默认中心点
    longitude: 116.4074,
    timeText: '',
    timeMode: 'clock',          // 'clock'（今天 09:00）| 'relative'（2 小时前）
    mapScale: 14,
    isDark: false,
    pinIcon: '/images/marker-p0.png'
  },

  onLoad: function () {
    this._initPlatform();
    this._initTheme();
    this._initTimeMode();
    this._calcLayout();
  },

  onShow: function () {
    this._calcLayout();
    this._applyDark(this._readSystemDark());
    this.loadData(false);
    this._startTimeTicker();
  },

  onHide: function () {
    this._stopPulse();
    this._stopTimeTicker();
    if (this._zoomResumeTimer) {
      clearTimeout(this._zoomResumeTimer);
      this._zoomResumeTimer = null;
    }
  },

  onUnload: function () {
    this._stopPulse();
    this._stopTimeTicker();
    if (this._zoomResumeTimer) {
      clearTimeout(this._zoomResumeTimer);
      this._zoomResumeTimer = null;
    }
    if (this._themeHandler && typeof wx.offThemeChange === 'function') {
      wx.offThemeChange(this._themeHandler);
      this._themeHandler = null;
    }
  },

  onResize: function () {
    this._calcLayout();
  },

  /* ---------- 平台与主题 ---------- */
  _initPlatform: function () {
    try {
      var dev = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {};
      var platform = String(dev.platform || '').toLowerCase();
      this.setData({ isIOS: platform === 'ios' });
    } catch (e) {
      this.setData({ isIOS: false });
    }
  },

  _readSystemDark: function () {
    try {
      var info = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()) || {};
      return info.theme === 'dark';
    } catch (e) {
      return false;
    }
  },

  _applyDark: function (dark) {
    if (dark === this.data.isDark) return;
    this.setData({ isDark: dark });
  },

  _initTheme: function () {
    var self = this;
    self.setData({ isDark: self._readSystemDark() });

    if (self._themeBound || typeof wx.onThemeChange !== 'function') return;
    self._themeBound = true;
    self._themeHandler = function (res) {
      self._applyDark(res.theme === 'dark');
    };
    wx.onThemeChange(self._themeHandler);
  },

  /* ---------- 多机型弹性比例布局 ---------- */
  _calcLayout: function () {
    var win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    var statusBar = win.statusBarHeight || 20;
    var windowWidth = win.windowWidth || 375;
    var windowHeight = win.windowHeight || 667;

    // 自定义导航行高：微信官方推荐算法（胶囊按钮上下留白对称）
    var navBar = 44;
    try {
      var menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.height) {
        navBar = (menu.top - statusBar) * 2 + menu.height;
      }
    } catch (e) { /* 开发者工具偶发取不到，回退 44 */ }
    if (!navBar || navBar < 32) navBar = 44;

    // 按屏幕尺寸分五档：兼顾华为折叠屏外屏（超小/矮屏）与 iPad/平板全幅大屏
    var sizeClass = 'layout-regular';
    var topExtra = 10;
    if (windowHeight <= 520 || windowWidth <= 320) {
      sizeClass = 'layout-mini';
      topExtra = 2;
    } else if (windowWidth >= 560) {
      sizeClass = 'layout-tablet';
      topExtra = 12;
    } else if (windowHeight <= 680 || windowWidth <= 360) {
      sizeClass = 'layout-compact';
      topExtra = 6;
    } else if (windowWidth >= 415 || windowHeight >= 861) {
      sizeClass = 'layout-large';
      topExtra = 12;
    }

    // 外屏等极矮窗口下，兜底限制顶部留白不超过屏高 22%，绝不把地图和页脚挤出视野
    var rawTop = Math.round(statusBar + navBar + topExtra);
    var topGap = sizeClass === 'layout-mini' ? Math.min(rawTop, Math.round(windowHeight * 0.22)) : rawTop;
    if (topGap !== this.data.topGap || sizeClass !== this.data.sizeClass) {
      this.setData({
        topGap: topGap,
        sizeClass: sizeClass
      });
    }
  },

  /* ---------- 水波纹动画（统一走 cover-image，呼吸间歇周期降耗） ---------- */
  _startPulse: function () {
    var self = this;
    if (self._pulseTimer || self._pulseRestTimer || !self.data.hasData) return;
    var steps = 0;
    var maxSteps = PULSE_FRAMES.length * PULSE_ROUNDS;
    self._pulseTimer = setInterval(function () {
      var idx = steps % PULSE_FRAMES.length;
      steps += 1;
      self.setData({
        pinIcon: '/images/' + PULSE_FRAMES[idx] + '.png'
      });
      if (steps >= maxSteps) {
        clearInterval(self._pulseTimer);
        self._pulseTimer = null;
        self.setData({ pinIcon: '/images/marker-static.png' });
        self._pulseRestTimer = setTimeout(function () {
          self._pulseRestTimer = null;
          self._startPulse();
        }, PULSE_REST_MS);
      }
    }, PULSE_MS);
  },

  _stopPulse: function () {
    if (this._pulseTimer) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
    if (this._pulseRestTimer) {
      clearTimeout(this._pulseRestTimer);
      this._pulseRestTimer = null;
    }
  },

  /* ---------- 时间保鲜与偏好记忆 ---------- */
  _initTimeMode: function () {
    try {
      var saved = wx.getStorageSync(TIME_MODE_KEY);
      if (saved === 'relative' || saved === 'clock') {
        this.setData({ timeMode: saved });
      }
    } catch (e) { /* 忽略存储异常 */ }
  },

  _refreshTimeText: function () {
    if (!this._parsedTime) return;
    var next = this.data.timeMode === 'relative'
      ? formatRelativeTime(this._parsedTime)
      : formatClockTime(this._parsedTime);
    if (next !== this.data.timeText) {
      this.setData({ timeText: next });
    }
  },

  _startTimeTicker: function () {
    var self = this;
    if (self._timeTicker) return;
    self._timeTicker = setInterval(function () {
      self._refreshTimeText();
    }, TIME_TICK_MS);
  },

  _stopTimeTicker: function () {
    if (this._timeTicker) {
      clearInterval(this._timeTicker);
      this._timeTicker = null;
    }
  },

  toggleTimeMode: function () {
    if (!this._parsedTime) return;
    hapticLight();
    var nextMode = this.data.timeMode === 'clock' ? 'relative' : 'clock';
    this.setData({ timeMode: nextMode });
    try { wx.setStorageSync(TIME_MODE_KEY, nextMode); } catch (e) { /* 忽略 */ }
    this._refreshTimeText();
  },

  /* ---------- 取数 ---------- */
  onManualRefresh: function () {
    hapticLight();
    this.loadData(true);
  },

  loadData: function (manual) {
    var self = this;
    if (self._requesting) return;
    self._requesting = true;
    if (manual) self.setData({ refreshing: true });

    wx.request({
      url: SERVER + '/api/latest',
      timeout: REQUEST_TIMEOUT,
      success: function (r) {
        var d = r.data && r.data.data;
        if (!d || !d.location) {
          if (!self.data.hasData) {
            self.setData({ loading: false, hasData: false, loadError: false });
          } else if (manual) {
            wx.showToast({ title: '暂无新位置', icon: 'none' });
          }
          return;
        }
        var loc = d.location;
        self._parsedTime = parseTimestamp(d.timestamp);
        var timeText = self.data.timeMode === 'relative'
          ? formatRelativeTime(self._parsedTime)
          : formatClockTime(self._parsedTime);

        self.setData({
          loading: false,
          hasData: true,
          loadError: false,
          latitude: loc.latitude,
          longitude: loc.longitude,
          timeText: timeText
        });
        self._startPulse();
      },
      fail: function () {
        if (!self.data.hasData) {
          self.setData({ loading: false, hasData: false, loadError: true });
        } else if (manual) {
          wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none' });
        }
      },
      complete: function () {
        self._requesting = false;
        if (self.data.refreshing) {
          // 让旋转动画至少转满一圈，视觉反馈更顺滑
          setTimeout(function () {
            self.setData({ refreshing: false });
          }, 360);
        }
      }
    });
  },

  /* ---------- 缩放交互 ---------- */
  _handleZoom: function (delta) {
    var self = this;
    var targetScale = Math.max(3, Math.min(20, self.data.mapScale + delta));
    if (targetScale === self.data.mapScale) return;

    hapticLight();
    self._stopPulse();
    if (self._zoomResumeTimer) {
      clearTimeout(self._zoomResumeTimer);
    }

    self.setData({
      mapScale: targetScale
    });

    self._zoomResumeTimer = setTimeout(function () {
      self._zoomResumeTimer = null;
      self._startPulse();
    }, 400);
  },

  mapZoomIn: function () {
    this._handleZoom(1);
  },

  mapZoomOut: function () {
    this._handleZoom(-1);
  },

  /* ---------- 分享 ---------- */
  onShareAppMessage: function () {
    return {
      title: '宁狗在哪 🐕',
      path: '/pages/home/home',
      imageUrl: '/images/dog-share.png'
    };
  },

  onShareTimeline: function () {
    return {
      title: '宁狗在哪 🐕',
      imageUrl: '/images/dog-share.png'
    };
  }
});
