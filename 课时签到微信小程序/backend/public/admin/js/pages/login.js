'use strict';
/**
 * 登录页增强（登录逻辑本身在 js/app.js 中绑定）
 * - 大写锁定提示
 * - 记住上次登录工号（不保存密码）
 * - 输入时清除上一次的行内错误
 */
(function (A) {
  function init() {
    var pwd = document.getElementById('login-password');
    var no = document.getElementById('login-no');
    var err = document.getElementById('login-error');
    if (!pwd) return;

    pwd.addEventListener('keyup', function (e) {
      var on = e.getModifierState && e.getModifierState('CapsLock');
      if (on) {
        if (!document.getElementById('caps-hint')) {
          var d = document.createElement('div');
          d.id = 'caps-hint';
          d.className = 'help-text';
          d.style.color = '#d97706';
          d.textContent = '提示：大写锁定（CapsLock）已开启';
          pwd.parentNode.appendChild(d);
        }
      } else {
        var h = document.getElementById('caps-hint');
        if (h) h.parentNode.removeChild(h);
      }
    });

    [no, pwd].forEach(function (el) {
      el.addEventListener('input', function () { if (err) err.textContent = ''; });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.Admin);
