/* ============================================================
   宁狗在哪 · 小程序端 · v3.0
   ⚠ 与网页版 app.js 行为一一对应，改一边必须同步另一边
   ============================================================ */
var APP = getApp();
var SERVER = APP.globalData.serverUrl;

var PULSE_MS = 170;             // 水波纹帧间隔，8 帧 ≈ 1.36 秒一轮

/* 标记图：逻辑 56x72 的 3x 图，显示 52x67，尖角末端落在 anchorY 上 */
var MARK_W = 60;
var MARK_H = 77;
var MARK_ANCHOR_Y = 0.8333;     // 60/72 —— 地面点
var PULSE_FRAMES = [
  'marker-p0', 'marker-p1', 'marker-p2', 'marker-p3',
  'marker-p4', 'marker-p5', 'marker-p6', 'marker-p7'
];

var BJ_OFFSET = 8 * 3600 * 1000;

/* 卡片内部高度常量，与 home.wxss 保持一致，改样式时同步改这里 */
var HEADER_H = 52;              // .card-head height
var FOOTER_H = 85;              // .footer：padding 14*2 + 内容 56.5

function bjMidnight(ms) {
  var d = new Date(ms + BJ_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/* 把服务端时间戳转成「今天 / 昨天 / 前天 / 3 天前」+ HH:MM
   不用 new Date(str)：iOS 的 JavaScriptCore 解析 "YYYY-MM-DD HH:MM:SS" 会返回 Invalid Date
   v3.1 起只负责出文本，不再判断「实时 / 延迟」 */
var DAY_LABELS = ['今天', '昨天', '前天'];
function describeTime(ts) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts || ''));
  if (!m) return '';
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
  var days = Math.round((bjMidnight(Date.now()) - bjMidnight(t)) / 86400000);
  if (days < 0) days = 0;   // 时钟误差导致的「未来时间」按今天算
  var dayText = days < DAY_LABELS.length ? DAY_LABELS[days] : days + ' 天前';
  return dayText + ' ' + m[4] + ':' + m[5];
}

Page({
  data: {
    loading: true,
    hasData: false,
    topGap: 102,
    mapHeight: 300,
    latitude: 39.9042,          // 示例默认兜底地图中心点纬度（北京）
    longitude: 116.4074,        // 示例默认经度
    timeText: '',
    mapScale: 14,
    isDark: false,              // 由 _initTheme 写入，控制压暗层与缩放条的配色
    pinIcon: '/images/marker-p0.png',
    markers: []
  },

  onLoad: function () {
    this._initTheme();
    this._calcLayout();
  },

  onShow: function () {
    // onLoad 之后必然紧跟 onShow，请求只放在这里，避免首次进入发两次
    this._calcLayout();
    this._applyDark(this._readSystemDark());   // 切后台期间可能改过系统主题
    // v3.2：不再上报位置，只读服务端。位置由 Mac 定时任务（每天 4 次）写入。
    // 这样小程序不需要 wx.getLocation，也就不用去申请那个接口权限。
    this.loadData();
  },

  onHide: function () {
    this._stopPulse();          // 切后台立刻停动画，别再 setData
    if (this._zoomResumeTimer) {
      clearTimeout(this._zoomResumeTimer);
      this._zoomResumeTimer = null;
    }
  },

  onUnload: function () {
    this._stopPulse();
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

  /* ---------- 主题 ---------- */
  /* 框架配色由 wxss 的 @media (prefers-color-scheme: dark) 负责，另挂 .theme-dark 兜底
     （部分安卓 webview 不响应系统配色查询）。isDark 只驱动这个兜底类，
     地图不参与 —— 它在 iOS 上由微信自己按 darkmode 压暗。 */
  _readSystemDark: function () {
    try {
      var info = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()) || {};
      return info.theme === 'dark';
    } catch (e) {
      return false;   // 基础库过旧读不到 theme，按浅色处理
    }
  },

  _applyDark: function (dark) {
    if (dark === this.data.isDark) return;
    this.setData({ isDark: dark });
    // 深色模式下底图 markers 清空，由置顶在遮罩层之上的 cover-image 接管，防止被压暗
    if (this._mkPos) {
      if (dark) {
        this.setData({ markers: [] });
      } else {
        this.setData({
          markers: [this._buildMarker(this._mkPos.latitude, this._mkPos.longitude, PULSE_FRAMES[0])]
        });
      }
    }
  },

  _initTheme: function () {
    var self = this;
    var dark = self._readSystemDark();
    self.setData({ isDark: dark });

    // 全局只绑一次，避免来回切页面时叠加回调
    if (self._themeBound || typeof wx.onThemeChange !== 'function') return;
    self._themeBound = true;
    self._themeHandler = function (res) {
      self._applyDark(res.theme === 'dark');
    };
    wx.onThemeChange(self._themeHandler);
  },

  /* ---------- 布局 ---------- */
  _calcLayout: function () {
    var win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    var statusBar = win.statusBarHeight || 20;
    var windowHeight = win.windowHeight || 667;

    // 自定义导航行高：微信官方推荐算法（胶囊按钮上下留白对称）
    var navBar = 44;
    try {
      var menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.height) navBar = (menu.top - statusBar) * 2 + menu.height;
    } catch (e) { /* 开发者工具偶尔取不到，用 44 兜底 */ }
    if (!navBar || navBar < 32) navBar = 44;

    var safeBottom = 0;
    if (win.safeArea && win.screenHeight) {
      safeBottom = Math.max(0, win.screenHeight - win.safeArea.bottom);
    }

    // 卡片上沿 = 状态栏 + 胶囊按钮行 + 8px，别压到胶囊
    var topGap = statusBar + navBar + 8;
    this.setData({
      topGap: topGap,
      // -1 是 .map-wrap 的 1px 上边线
      mapHeight: Math.max(windowHeight - topGap - HEADER_H - FOOTER_H - safeBottom - 1, 160)
    });
  },

  /* ---------- 标记 ---------- */
  _buildMarker: function (lat, lng, icon) {
    return {
      id: 0,
      latitude: lat,
      longitude: lng,
      iconPath: '/images/' + icon + '.png',
      width: MARK_W,
      height: MARK_H,
      anchorX: 0.5,
      anchorY: MARK_ANCHOR_Y,
      zIndex: 9
    };
  },

  _startPulse: function () {
    var self = this;
    if (self._pulseTimer || !self._mkPos) return;
    var i = 0;
    self._pulseTimer = setInterval(function () {
      if (!self._mkPos) return;
      i = (i + 1) % PULSE_FRAMES.length;
      var icon = PULSE_FRAMES[i];
      var iconPath = '/images/' + icon + '.png';
      if (self.data.isDark) {
        // 深色模式：仅更新置顶浮动图钉的图片帧（不重复 setData markers，杜绝原生 map 组件重绘微抖）
        self.setData({
          pinIcon: iconPath
        });
      } else {
        // 浅色模式：原生 markers 渲染水波纹
        self.setData({
          markers: [self._buildMarker(self._mkPos.latitude, self._mkPos.longitude, icon)]
        });
      }
    }, PULSE_MS);
  },

  _stopPulse: function () {
    if (this._pulseTimer) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
  },

  /* ---------- 取数 ---------- */
  loadData: function () {
    var self = this;
    wx.request({
      url: SERVER + '/api/latest',
      success: function (r) {
        var d = r.data && r.data.data;
        if (!d || !d.location) {
          if (self.data.loading) self.setData({ loading: false, hasData: false });
          return;
        }
        var loc = d.location;
        var timeText = describeTime(d.timestamp);

        self._mkPos = { latitude: loc.latitude, longitude: loc.longitude };
        var firstIcon = '/images/' + PULSE_FRAMES[0] + '.png';
        var initialMarkers = self.data.isDark ? [] : [self._buildMarker(loc.latitude, loc.longitude, PULSE_FRAMES[0])];
        self.setData({
          loading: false,
          hasData: true,
          latitude: loc.latitude,
          longitude: loc.longitude,
          timeText: timeText,
          pinIcon: firstIcon,
          markers: initialMarkers
        });
        // v3.1：不再按时间判定状态，水波纹常驻播放
        self._startPulse();
      },
      fail: function () {
        if (self.data.loading) self.setData({ loading: false, hasData: false });
      }
    });
  },

  /* ---------- 交互 ---------- */
  _handleZoom: function (delta) {
    var self = this;
    var targetScale = Math.max(3, Math.min(20, self.data.mapScale + delta));
    if (targetScale === self.data.mapScale) return;

    // 缩放防抖：暂停水波纹换帧，避免地图缩放动画（~350ms）与 170ms 图片解码碰撞产生闪烁
    self._stopPulse();
    if (self._zoomResumeTimer) {
      clearTimeout(self._zoomResumeTimer);
    }

    self.setData({
      mapScale: targetScale
    });

    // 等待地图缩放动画平稳落定（400ms）后，重新唤醒水波纹
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

  onShareAppMessage: function () {
    return {
      title: '宁狗在哪 🐕',
      path: '/pages/home/home',
      imageUrl: '/images/dog-share.png'
    };
  }
});
