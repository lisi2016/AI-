// 课时记录存储：演示阶段用本地 storage，接入后端后改为接口读写
// 页面只调用本模块，不直接碰 storage，便于替换
// 接入真实后端时，页面改调 utils/api.js（契约见 docs/miniapp/api-contract.md），
// store.js 退化为本地草稿缓存与离线兜底，不再作为数据主源

var mock = require('./mock.js');

var KEY = 'ch_records_v1';

function loadCache() {
  var list = wx.getStorageSync(KEY);
  if (!list || !list.length) {
    list = mock.records.slice(0);
    wx.setStorageSync(KEY, list);
  }
  return list;
}

function getAll() {
  return loadCache();
}

function getById(id) {
  var list = loadCache();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function add(record) {
  var list = loadCache();
  list.unshift(record);
  wx.setStorageSync(KEY, list);
  return record;
}

function update(id, patch) {
  var list = loadCache();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      for (var k in patch) {
        list[i][k] = patch[k];
      }
      wx.setStorageSync(KEY, list);
      return list[i];
    }
  }
  return null;
}

function countByStatus() {
  var list = loadCache();
  var r = { done: 0, wait: 0, expired: 0, rejected: 0, makeup: 0, total: 0 };
  for (var i = 0; i < list.length; i++) {
    var s = list[i].status;
    if (r[s] !== undefined) r[s]++;
    // 已确认与已补签计入正式学时
    if (s === 'done' || s === 'makeup') r.total += (list[i].hours || 0);
  }
  return r;
}

module.exports = {
  getAll: getAll,
  getById: getById,
  add: add,
  update: update,
  countByStatus: countByStatus
};
