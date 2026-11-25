# ST-Charta（ST-素笺）

一个纯前端扩展，整理酒馆的「用户设定管理」（Persona Management）面板。

- **桌面端**：保持原版左右并排（左列表 / 右编辑），只把左侧列表换成带文件夹和星标的自建列表。
- **移动端 / 窄屏（≤1000px，纯触摸设备放宽到 1200px）**：拆成两个独立全屏视图。默认只显示「列表」；点人设行只切换身份，`⋯ → 进入编辑` 才进入编辑视图（列表完全隐藏，顶部有「返回列表」）。不再是一条长页面里上下堆叠。
- **文件夹**：单层，一个人设只属于一个文件夹；不属于任何文件夹的进「未分组」。
- **星标**：独立「★ 置顶」区，点星标立刻飞到最上面。
- **存储**：文件夹与星标写入服务端 `extension_settings`，随酒馆设置一起保存和备份，换浏览器 / 换手机 / 重装都不丢。

---

## 安装

### 方法一：酒馆一键安装（推荐）
打开SillyTavern，点击顶部菜单的**“扩展”**。
点击 Install Extension（安装扩展）。
粘贴本仓库的链接，点击确认即可。
### 方法二：把本目录放到：

```
public/scripts/extensions/third-party/ST-Charta/
```

确认四个文件齐全：`manifest.json`、`index.js`、`style.css`、`README.md`，然后在酒馆「扩展」里确认 **ST-Charta (用户设定整理)** 已启用，刷新页面。

---

## 怎么用

### 列表视图

- 点击人设行（按钮以外的地方）：**只切换为该人设**，停在列表里；进编辑器走 `⋯ → 进入编辑`。
- 行尾图标：`★` 置顶 / `链接` 快捷绑定（点一下把这个人设绑到当前打开的角色，等同于原生「角色」锁；已绑定时会提示）/ `骷髅` 删除（原生确认弹窗）/ `⋯` 更多。
- 卡片的第二行「当前链接」会写出具体名字：`角色 · 测试9`、`群组 · 某某团`、`默认`、`聊天`，没绑定时显示 `—`。
- `⋯` 菜单：**移动到文件夹… / 重命名 / 复制一份 / 单独导出 / 进入编辑**。删除只走骷髅，菜单里不再重复。
- `单独导出`：一个人设导成一个 JSON，结构与原生「备份」完全一致（`personas` + `persona_descriptions`），可以直接用原生「恢复」导入到别的酒馆。
- 顶部「文件夹」按钮：新建文件夹（新文件夹会以空分组出现在列表里，可直接把人设拖进去）。
- 文件夹标题栏：点击折叠 / 展开；右侧 `笔` 重命名、`垃圾桶` 删除（里面的人设回到「未分组」，不会删人设）。
- 右上角 `⇲` 一键折叠 / 展开全部。
- 桌面端可把行拖到文件夹标题上完成归属；拖到「★ 置顶」等于加星标。
- 「搜索」沿用原生搜索框，匹配人设名称、标题、描述，**也匹配文件夹名**（命中文件夹名时整组显示）；搜索时自动展开分组。
- 分组顺序固定为：`★ 置顶` → `未分组` → 自定义文件夹（按创建顺序）。
- `A-Z` 只影响**组内**顺序，置顶组永远在最前。
- 列表是**无限滚动**：首屏 60 条，滚到底部自动续 60 条，末尾会显示剩余数量，滚完提示「已全部显示」。不切断分组，也没有页码。
- 网格按钮沿用原生 `Personas_GridView` 偏好。

### 编辑视图

原生右列整块保留，所有按钮、下拉、文本框、「更多…」都与原版完全一致，只是重新排了位置：顶部返回条 → 「当前人设」+ 名字胶囊 → 图标行 → 描述 → Token → 插入位置 → 链接 → 全局设置。改名字/改标题用这里的原生铅笔按钮。

---

## 存储结构

写入服务端 `settings.json` → `extension_settings["ST-Charta"]`：

```json
{
  "version": 1,
  "folders": [{ "id": "f_xxx", "name": "文件夹名", "order": 0 }],
  "assign":  { "1730000000000-名字.png": "f_xxx" },
  "stars":   { "1730000000000-名字.png": 1 },
  "collapsed": { "star": true, "none": false, "f_xxx": true },
  "grid": false,
  "sort": "asc",
  "current": "1730000000000-名字.png"
}
```

- **主键是头像文件名 `avatarId`**。酒馆里人设「重命名」只改显示名，不改文件名（`personas.js` 的 `renamePersona` 只写 `power_user.personas[avatarId]`），所以改名不会丢文件夹归属。
- 每次拿到人设列表会做一次 reconcile：人设被删除后，对应的 `assign` / `stars` 条目自动清掉。
- `current` 只用于列表高亮，权威值始终来自酒馆本身（`PERSONA_CHANGED` 事件）。

---

## 实现方式与边界

| 原生元素 | 处理 | 原因 |
| --- | --- | --- |
| `#user_avatar_block`（原生列表） | **隐藏**，但保留在 DOM | 原生每次增删改都会 `empty()` 重建，无法在其上做分组装饰；同时它仍是「选中人设」的委托入口 |
| `#persona_pagination_container`（原生分页） | **隐藏** | 分页会把一个文件夹切到两页，与文件夹视图冲突；改用组内折叠控制长度 |
| `.persona_management_right_column`（编辑区） | **原样复用** | 零成本继承重命名、同步、Lore、换图、复制、删除、描述、位置、Token、锁、连接等全部原生逻辑 |
| `#persona_search_bar` / `#persona_sort_order` / `#persona_grid_toggle` | **监听但不清除原生处理器** | 原生处理器照常跑（只影响隐藏列表）；排序会额外把下拉复原为 A-Z，避免原生「搜索排序」模式闪动 |
| `#create_dummy_persona`、`#avatar_upload_file` | 原样使用 | 顶部「创建」走原生；换头像/新建仍走编辑页原生的图片按钮 |

选中人设的方式：往隐藏的 `#user_avatar_block` 里临时插入一个 `.avatar-container[data-avatar-id]` 并 `click()`，让酒馆自己的委托处理器执行完整的 `setUserAvatar`（名字、描述、锁、落盘、toast 全按原生走）。若 400ms 内没有切换成功，自动回退到 `/persona-set mode=lookup "<avatarId>"`。

---

## 兼容性与降级

- 面向 SillyTavern **1.19.0** 的 DOM 编写。
- 窄屏两屏模式由 JS 判定后给 `<body>` 打 `.charta-narrow`，且**显隐直接写成内联 `!important`**，不依赖样式表是否命中或被缓存；两列在窄屏下都是 `position: absolute; inset: 0`，谁显示谁铺满，不参与 flex 宽度计算。
- 判定阈值：视口 ≤1000px，或触摸设备（`coarse` / `maxTouchPoints > 0`）≤1400px，避免手机布局视口被算大后两屏模式不触发。
- 下拉菜单挂在抽屉内部（`.openDrawer` 的后代），并在自身 `touchstart` / `mousedown` 上阻止冒泡。酒馆在 `<html>` 上监听这两个事件，点到抽屉之外就会把整个抽屉收起——菜单若挂在 `body`，点菜单项会被当成「点了外面」，抽屉先收起来、事件才迟到。
- 标题右侧有一个很淡的版本标签：`v1.1.3 · 双屏` / `v1.1.3 · 单页`。悬停能看到当前判定用的宽度、`coarse`、`touch` 值，用来确认手机加载到的是哪一版、走的是哪套布局。
- 启动先探测 `#persona-management-block`、`.persona_management_left_column`、`.persona_management_right_column`、`#user_avatar_block`；任一缺失就**完全不接管**，控制台警告，原生面板照旧可用。
- 所有样式以 `body.charta-on` 作用域，脚本没跑起来时不会隐藏任何原生元素。
- 依赖的外部接口仅：`SillyTavern.getContext()`（`extensionSettings`、`saveSettingsDebounced`、`getRequestHeaders`、`powerUserSettings`、`eventSource`、`executeSlashCommandsWithOptions`、`callGenericPopup`、`getThumbnailUrl`、`accountStorage`）与 `POST /api/avatars/get`。

## 已知边界

1. **用无限滚动而不是分页**：分页会把同一个文件夹切到两页，读起来断裂；现在首屏 60 条、滚到底续 60 条。几千条也不会一次全渲染。
2. **星标优先于文件夹**：加了星标的人设只在「★ 置顶」出现，不会同时出现在它的文件夹里（你要求的「飞上去」）。取消星标后自动回到原文件夹。
3. **桌面端布局未改**：仍是原生左右两栏比例，只重做了列表卡片；两级视图只在 ≤1000px（触摸设备 ≤1400px）生效。
4. **重命名**：列表菜单的「重命名」只改显示名；要同时改「标题」请进编辑视图用原生铅笔按钮。
5. 依赖原生 `#user_avatar_block .avatar-container` 的点击委托；若酒馆未来改成其它选中入口，会自动走 slash 命令回退，但会多一次 toast。

## 性能

- 列表分块渲染：首屏 60 条，滚到底再追加 60 条；头像 `loading="lazy"`。
- 搜索、排序、刷新都走防抖；每次增删改只发一次 `/api/avatars/get`。
- 行内只绑定事件监听，没有逐行的 MutationObserver；文件夹/星标写入是纯内存对象，`saveSettingsDebounced` 合并落盘。
- 1000 条量级的首屏与追加都在几十毫秒内；几千条也只是多滚几次，不会一次铺满 DOM。

## License

MIT
