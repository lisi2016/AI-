'use strict';
/**
 * 后台 API 客户端（原生 fetch 封装，无第三方依赖）
 * - 统一前缀 /api/v1
 * - 自动携带 Authorization: Bearer <token>
 * - 收到 40101 自动清理登录态并回登录页
 * - 导出文件/附件必须带 token 用 fetch 拉 blob（不能直接 <img src> / <a href>）
 *   注：业务流程简化后不再产生手写签名图，课时明细页也不再渲染签名图
 */
window.Admin = window.Admin || {};
(function (A) {
  var BASE = '/api/v1';
  var K_TOKEN = 'kcsq_admin_token';
  var K_USER = 'kcsq_admin_user';
  var K_NO = 'kcsq_admin_no';

  var unauthorizedHandler = null;

  function ls() { return window.localStorage; }
  function ss() { return window.sessionStorage; }

  // ------------------------------------------------------------ 登录态存取
  function getToken() { return ls().getItem(K_TOKEN) || ss().getItem(K_TOKEN) || ''; }
  function getUser() {
    try { return JSON.parse(ls().getItem(K_USER) || ss().getItem(K_USER) || 'null'); }
    catch (e) { return null; }
  }
  /** @param persist true=localStorage（记住登录）false=sessionStorage（关浏览器即失效） */
  function setSession(token, user, no, persist) {
    clearSession();
    var store = persist ? ls() : ss();
    if (token) store.setItem(K_TOKEN, token);
    if (user) store.setItem(K_USER, JSON.stringify(user));
    if (no) {
      if (persist) ls().setItem(K_NO, no);
      else ss().setItem(K_NO, no);
    }
  }
  function clearSession() {
    [ls(), ss()].forEach(function (s) {
      s.removeItem(K_TOKEN); s.removeItem(K_USER); s.removeItem(K_NO);
    });
  }
  function rememberedNo() { return ls().getItem(K_NO) || ss().getItem(K_NO) || ''; }
  function hasToken() { return !!getToken(); }

  // ------------------------------------------------------------ 错误对象
  function makeError(status, code, msg, traceId) {
    var err = new Error(msg || '请求失败');
    err.status = status || 0;
    err.code = (code === undefined || code === null) ? -1 : code;
    err.msg = msg || '请求失败';
    err.traceId = traceId || '';
    return err;
  }

  function handleUnauthorized(msg) {
    clearSession();
    if (typeof unauthorizedHandler === 'function') unauthorizedHandler(msg);
  }

  // ------------------------------------------------------------ 请求
  function buildQuery(query) {
    if (!query) return '';
    var parts = [];
    Object.keys(query).forEach(function (k) {
      var v = query[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function request(method, path, opts) {
    var o = opts || {};
    var url = (path.indexOf('/api/') === 0 ? path : BASE + path) + buildQuery(o.query);
    var headers = {};
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    var body;
    if (o.formData) {
      body = o.formData; // 交给浏览器自动设置 multipart boundary
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    if (o.headers) Object.keys(o.headers).forEach(function (k) { headers[k] = o.headers[k]; });

    return fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin',
    }).then(function (res) {
      var ct = (res.headers.get('Content-Type') || '').toLowerCase();
      if (ct.indexOf('json') < 0) {
        return res.text().then(function (text) {
          var err = makeError(res.status, -1, '接口返回非 JSON 内容（HTTP ' + res.status + '）：' + String(text).slice(0, 160));
          if (res.status === 401) { handleUnauthorized('登录已失效，请重新登录'); err.code = 40101; }
          throw err;
        });
      }
      return res.json().then(function (json) {
        if (json && json.code === 0) return json.data;
        var code = json && json.code;
        var msg = (json && json.msg) || ('请求失败（HTTP ' + res.status + '）');
        var err = makeError(res.status, code, msg, json && json.traceId);
        if (code === 40101) handleUnauthorized('登录已失效，请重新登录');
        throw err;
      });
    }, function (netErr) {
      throw makeError(0, -1, '网络请求失败：' + ((netErr && netErr.message) || '无法连接后端服务'));
    });
  }

  // ------------------------------------------------------------ 文件（带鉴权）
  /** 拉取二进制内容（导出文件 / 附件），返回 Blob */
  function fetchBlob(path, query) {
    var url = (path.indexOf('/api/') === 0 ? path : BASE + path) + buildQuery(query);
    var headers = {};
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, { method: 'GET', headers: headers, credentials: 'same-origin' }).then(function (res) {
      var ct = (res.headers.get('Content-Type') || '').toLowerCase();
      if (!res.ok || ct.indexOf('json') >= 0) {
        // 出错时后端返回 JSON
        if (ct.indexOf('json') >= 0) {
          return res.json().then(function (json) {
            var err = makeError(res.status, json && json.code, (json && json.msg) || '文件读取失败');
            if (json && json.code === 40101) handleUnauthorized('登录已失效，请重新登录');
            throw err;
          });
        }
        throw makeError(res.status, -1, '文件读取失败（HTTP ' + res.status + '）');
      }
      return res.blob();
    });
  }

  /** 下载文件到本地（带回退：blob 失败时用 token 直链） */
  function download(path, query, filename) {
    var url = (path.indexOf('/api/') === 0 ? path : BASE + path) + buildQuery(query);
    return fetchBlob(path, query).then(function (blob) {
      var objUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = objUrl;
      a.download = filename || 'download.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(objUrl); }, 8000);
      return { url: url, size: blob.size };
    });
  }

  A.api = {
    BASE: BASE,
    get: function (path, query) { return request('GET', path, { query: query }); },
    post: function (path, body, query) { return request('POST', path, { body: body === undefined ? {} : body, query: query }); },
    put: function (path, body) { return request('PUT', path, { body: body === undefined ? {} : body }); },
    del: function (path, query) { return request('DELETE', path, { query: query }); },
    upload: function (path, formData, query) { return request('POST', path, { formData: formData, query: query }); },
    fetchBlob: fetchBlob,
    download: download,
    getToken: getToken,
    getUser: getUser,
    setSession: setSession,
    clearSession: clearSession,
    rememberedNo: rememberedNo,
    hasToken: hasToken,
    /** 注册 40101 处理（由 app.js 注入） */
    onUnauthorized: function (fn) { unauthorizedHandler = fn; },
  };
})(window.Admin);
