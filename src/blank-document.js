// 由 background.js 在「登录新账号」时临时注册成 document_start 的内容脚本。
// 必须在页面脚本跑起来之前把存储清干净，否则站点会立刻把旧登录态写回去。
localStorage.clear();
sessionStorage.clear();
