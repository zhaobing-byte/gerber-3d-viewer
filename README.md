# FABVIEW Gerber 3D

FABVIEW Gerber 3D 是一个面向 PCB 贴片生产资料核对的本地 Web 应用。它在浏览器中解析 Gerber、BOM 和贴片坐标文件，将 PCB、焊盘及元件封装组合成可交互的 3D 视图，并使用企业物料库补全 BOM 编码和名称。

项目当前用于验证类似 SMT 下单前“元件选型确认”的工作流。Gerber、BOM 和坐标文件均在浏览器本地处理；电子物料由本机后端使用用户配置的金蝶 K/3 Cloud WebAPI 读取。

## 主要功能

- 导入单个或多个 Gerber/Excellon 文件，也可直接导入包含生产文件的 ZIP。
- 识别 KiCad、Altium、Eagle 的常见文件名和 Gerber X2 `FileFunction` 图层信息。
- 兼容 Altium 旧式后缀，包括 `GTL`、`GBL`、`GTS`、`GBS`、`GTO`、`GBO`、`GKO`、`GMn`、`GDn`、`GGn`、`GPT`、`GPB` 和 Excellon `.TXT`。
- 显示板框、基材、顶底铜层、阻焊、丝印、钻孔和网格，并支持等轴、顶层、底层视图。
- 导入 XLSX/XLS/CSV/TSV 格式的 BOM 与贴片坐标文件，自动识别中英文列名。
- 根据位号自动对齐 BOM、贴片坐标和 PCB 板框，支持顶层、底层及旋转角度。
- 通过登录界面配置金蝶服务地址、数据中心、集成用户、应用ID和应用密钥。
- 从金蝶 `BD_MATERIAL` 批量同步编码 21 至 29 开头的电子物料，使用“规格 + 封装”匹配 BOM，自动补全编码和物料名称。
- 无唯一匹配结果的 BOM 行自动进入“待处理元件”，可人工恢复或替换。
- BOM 支持确认勾选、行删除/恢复、列宽拖拽，以及物料名称和规格双击编辑。
- BOM 行可定位并高亮 3D 元件；点击 3D 元件也会自动高亮并滚动到对应 BOM 行。
- 自动匹配本地 3D 封装，支持 STEP/STP 和 GLB；STEP 模型可保留原始零件颜色。
- 只有已通过数据库匹配且存在 3D 封装的电子元件才会显示在 PCB 上。
- 金蝶物料页面支持字段导航、搜索、重新同步、3D 封装状态检查和手动模型导入。
- 手动导入 3D 封装时可直接选择 `.zip` 压缩包批量入库：包内 `<分类>.3dshapes/` 命中的已有分类自动归位，库内没有的分类自动新建，其余落到所选分类。

## 技术栈

- React 19 + TypeScript
- Vite 7
- Three.js
- `web-gerber`：Gerber 图形解析与渲染
- `occt-import-js`：浏览器端 STEP/STP 解析
- SheetJS：BOM 和坐标表格解析
- JSZip：ZIP 生产资料读取
- Python 标准库：本机金蝶 API 代理、配置保存和生产构建静态服务

## 环境要求

- Node.js 20.19 或更高版本
- npm 10 或更高版本
- Python 3.10 或更高版本
- 支持 WebGL 2 的现代浏览器
- 可选：FreeCAD 1.0，用于批量将 STEP 模型转换为 GLB

## 本地运行

安装依赖：

```powershell
npm install
```

开发模式需要两个终端。先启动本机金蝶 API：

```powershell
npm run api
```

再启动 Vite 开发服务器：

```powershell
npm run dev
```

Vite 默认地址为 `http://127.0.0.1:5173/`。生产构建与本地预览：

```powershell
npm run build
npm run preview
```

`npm run preview` 会由本机 Python 服务同时提供生产构建和金蝶 API，默认地址为 `http://127.0.0.1:4173/`。

金蝶配置保存在 `server/config.json`。该文件已被 Git 忽略，API 也只向浏览器返回是否已保存密钥，不会返回 AppSecret 本身。

## 局域网部署

在作为服务器的电脑上双击 [start-lan-server.cmd](scripts/start-lan-server.cmd)，接受 Windows 管理员权限提示。脚本会自动执行生产构建、识别默认网卡的 IPv4 地址、更新仅允许当前局域网网段访问的防火墙规则，并在后台启动 FABVIEW 服务。

重启电脑后再次运行同一个脚本即可。控制台会打印同事应使用的访问地址，例如 `http://192.168.123.137:4173/`。也可以从项目根目录运行：

```powershell
npm run deploy:lan
```

默认允许与服务器同一子网的设备访问。需要指定网段或跳过本次构建时，可运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-lan-server.ps1 -AllowedSubnet '192.168.123.0/24'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-lan-server.ps1 -SkipBuild
```

停止部署时，双击 [stop-lan-server.cmd](scripts/stop-lan-server.cmd)，或运行：

```powershell
npm run stop:lan
```

停止脚本只会关闭监听端口的 `kingdee_server.py`，并删除 `FABVIEW LAN 4173` 防火墙规则。若计划很快再次部署并希望保留规则，可运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-lan-server.ps1 -KeepFirewallRule
```

服务器需要保持开机且不能休眠。`server/config.json`、`footprint/3dmodels` 和 `footprint` 下的匹配记录均由服务器共享；该部署不包含登录鉴权，仅应在可信局域网中使用，不能将端口映射到公网。

## 推荐使用流程

1. 点击“金蝶 ERP”，填写连接信息并测试登录。
2. 保存配置，程序会自动同步金蝶电子物料。
3. 导入 Gerber 文件或生产资料 ZIP。
4. 导入 BOM 文件。
5. 导入贴片坐标文件。
6. 检查“核对元件”和“待处理元件”两个表格。
7. 在 BOM 表格与 PCB 3D 视图之间点击定位，确认封装、位号、板面和方向。
8. 对未匹配物料补充数据库记录或手动绑定 3D 模型。

重新导入 BOM 或从金蝶重新同步时，程序会重新执行数据库匹配。匹配要求规格字段和封装字段同时成立；候选结果不唯一时不会自动采用，以免错误绑定物料编码。

## 支持的输入

| 数据 | 格式 | 关键字段 |
| --- | --- | --- |
| Gerber/钻孔 | Gerber、Excellon、ZIP | 图层类型、板框、单位 |
| BOM | XLSX、XLS、CSV、TSV | 位号、规格/参数、封装、数量 |
| 贴片坐标 | XLSX、XLS、CSV、TSV、TXT、POS | 位号、X、Y、角度、板面 |
| 电子物料库 | 金蝶 K/3 Cloud WebAPI | 编码、物料名称、规格、状态、使用组织 |
| 手动 3D 模型 | STEP、STP、GLB、ZIP | 与目标物料人工绑定；ZIP 按目录名批量归位 |

坐标解析支持毫米、mil 和英寸。无法识别板框时，程序会使用全部生产图层的外接矩形作为临时板体并显示提示。

## BOM 与金蝶物料匹配

程序会规范化大小写、空格、常见单位写法和封装别名，再对规格及封装进行联合匹配。电阻、电容和电感还会结合位号前缀及物料名称中第一个 `|` 后的封装字段进行判断。

- 标记为 `【停售】` 或禁用的数据库物料不会参与自动匹配。
- 只有唯一的最高分候选项才会自动绑定。
- 匹配成功后，BOM 会写入数据库中的编码和物料名称。
- 匹配失败或结果有歧义时，该行进入“待处理元件”。
- 3D 展示只使用已匹配 BOM 行中的位号。

## 3D 封装库

完整 KiCad 模型库位于 [`footprint/3dmodels`](./footprint/3dmodels)，目录按中文 `.3dshapes` 分类保存。它是本机模型源，不进入 Git；应用通过本机 Python 服务按需读取目录清单，并仅在用户选中模型时传输对应的 STEP/STP/GLB 文件，因此不会把完整模型库打进前端构建产物。详细命名、坐标原点、分类和恢复方法见 [`footprint/README.md`](./footprint/README.md)。

模型绑定使用稳定的根相对路径，例如：

```text
/footprint/3dmodels/电容_贴片.3dshapes/C_0603_1608Metric.step
```

同名 STEP/STP 和 GLB 同时存在时，程序优先使用 STEP/STP，以保留模型原始颜色。通过选择窗口导入模型后，目录清单会立即刷新；不需要重新构建前端。

### 压缩包批量导入

在 3D 封装选择窗口里点“导入 3D 封装”，除了单个 `.step` / `.stp` / `.glb`，也可以直接选择 `.zip` 压缩包，由本机 Python 服务解压归位：

- 包内最近的 `<分类>.3dshapes/` 目录决定模型去向：库内已存在该分类就直接归位，库内没有就自动新建该分类目录；没有该层级的条目（含散装文件）写入面板上选的默认分类。
- 库为空（`footprint/3dmodels` 下没有任何分类目录）时，面板会提供「按包内分类自动归位」档位（`category=__auto__`）：不指定默认分类，完全按包内目录结构重建分类，没有 `<分类>.3dshapes/` 层级的条目会被跳过。用于从零恢复整库，无需先保留任一分类目录；单个模型文件仍必须指定已有分类。
- 深层子目录会被拍平，只保留文件名——库契约是 `<分类>.3dshapes/<模型>` 两级。
- 非模型条目、`__MACOSX`、`Thumbs.db` 等系统垃圾会被跳过，导入报告里会列出被跳过的条目与原因。
- 同名文件覆盖，条目路径不参与拼接，结构上不存在 zip-slip。
- 自动新建的分类不会写进 `src/footprint-categories.ts`，未登记的目录会回落到「其他」大类；需要正式归入六大类时在 `src/footprint-categories.ts` 里补登记。

限额：单个模型 80 MB，压缩包整包 2 GB，解压后总量 8 GB，最多 40000 个条目。导入完成后会刷新模型清单，模型可立刻在选择窗口和 3D 视图中使用。

从本机 KiCad 10 模型库同步当前清单中的标准模型：

```powershell
& .\scripts\sync-kicad-footprints.ps1
```

使用 FreeCAD 批量转换 STEP 为 GLB：

```powershell
npm run models:convert
```

转换脚本默认寻找 `D:\Program Files\FreeCAD 1.0\bin\freecadcmd.exe`。其他安装位置可直接调用脚本并传入参数：

```powershell
& .\scripts\convert-step-models.ps1 -FreeCadCmd "C:\Program Files\FreeCAD 1.0\bin\freecadcmd.exe"
```

## 项目结构

```text
gerber-3d-viewer/
├─ footprint/                 3D 封装源库及匹配清单
├─ scripts/                   KiCad 模型同步和 STEP 转换脚本
├─ server/
│  ├─ kingdee_server.py      本机配置、API 路由和静态服务
│  └─ kingdee_api.py         K/3 Cloud 登录及物料查询客户端
├─ src/
│  ├─ App.tsx                页面、导入流程和 BOM 交互
│  ├─ PcbViewer.tsx          Three.js PCB/元件 3D 渲染与拾取
│  ├─ gerber.ts              Gerber/Excellon 读取及图层识别
│  ├─ assembly-data.ts       BOM、坐标和元件库表格解析
│  ├─ placement-alignment.ts 坐标与 PCB 板框对齐
│  ├─ component-library-matching.ts 物料数据库匹配
│  ├─ KingdeeConnectionPanel.tsx 金蝶连接配置界面
│  ├─ kingdee-api.ts         前端金蝶 API 类型与数据映射
│  ├─ footprint-library.ts   3D 封装索引与匹配
│  └─ step-model.ts          STEP 模型解析及材质转换
├─ package.json
└─ vite.config.ts
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run api` | 启动开发环境金蝶 API，监听 8765 端口 |
| `npm run build` | 执行 TypeScript 检查并生成生产构建 |
| `npm run preview` | 在 4173 端口启动生产构建及金蝶 API |
| `npm run test:server` | 运行金蝶配置和查询后端单元测试 |
| `npm run models:convert` | 使用 FreeCAD 将模型清单中的 STEP 转为 GLB |

## Git 工作方式

仓库默认分支为 `main`。建议每个完整功能或修复使用一次提交：

```powershell
git status
git add src README.md
git commit -m "feat: describe the change"
```

`node_modules`、`dist`、本地环境变量、日志文件和 `footprint/3dmodels` 本机模型库不会进入版本库。模型绑定记录保存在 `footprint/model-bindings.json`，可随源码提交。

## 当前限制

- 3D 钻孔目前使用深色几何模拟，未对板体执行布尔减孔。
- 复杂负片、特殊光圈宏和刚挠结合板仍需更多生产文件验证。
- 已同步的物料数据保存在当前浏览器会话中；手动 3D 模型绑定保存到 `footprint/model-bindings.json`，金蝶连接配置保存于本机，刷新后可直接重新同步。
- 模型贴装原点、单位或 0° 方向不符合规范时，仍需修正源模型。
