# 采集机信息查询接口说明(Importer API)

本文档介绍如何从数据采集机(Importer)读取**机器信息**和**当前任务信息**。
内容面向非技术读者,只涉及"查询/读取"类接口,不涉及任何修改操作。

每个接口按同一顺序介绍:**接口规格 → 返回内容说明 → 真实返回示例 → 示例解读**。
文中的真实示例均取自机器 `we-001.szx3.worldengine.ai` 的实际返回。

## 基本信息

- **访问地址**:`http://<采集机地址>:5025`,例如 `http://we-001.szx3.worldengine.ai:5025`
- **访问方式**:普通的 HTTP GET 请求。在浏览器地址栏输入完整网址即可查看,无需安装任何软件。
- **返回格式**:JSON(一种通用的结构化文本格式,浏览器可直接显示)

---

## 1. 查询机器信息

### 1.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/api/config/machine` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5025/api/config/machine` |
| 参数 | 无 |
| 返回 | 这台采集机的完整配置(JSON) |

### 1.2 返回内容说明

返回由若干个"板块"组成,每个板块描述机器的一个方面:

| 板块 | 含义 |
| --- | --- |
| `misc` | 机器身份:`computer_id` 是主机编号,`machine_id` 是这台采集机的唯一名字,每条采集数据都会带上它 |
| `collector` | 采集程序:程序类型(`type`)、工作流(`workflow`)、随附的辅助工具(`aux`),以及程序运行所需的资源设置(CPU 配额、GPU 等) |
| `commander` | 遥操作输入设备:机器所用的操控套件和手部设备 |
| `cameras` | 摄像头设置:采集时使用哪些画面来源 |
| `storage` | 数据存放位置与录制格式 |
| `vst` | 头显透视视频的参数(分辨率、帧率) |

日常最常用的是 `misc.machine_id`(机器叫什么)和 `collector.type`(跑的是什么采集程序);其余板块主要供技术人员核对机器配置。

### 1.3 真实返回示例

```json
{
    "cameras": {
        "overlay": {
            "camera_source": "quest",
            "ego_camera": "vst_left",
            "quest_ip": "usb"
        },
        "vst_left": { "eye": "left", "type": "quest" },
        "vst_right": { "eye": "right", "type": "quest" }
    },
    "collector": {
        "type": "rdc-exodus",
        "workflow": "hermes",
        "aux": [
            {
                "localized_name": "机器全套标定",
                "name": "hermes_calibration",
                "command": "python scripts/hermes/hermes_calibration.py -c /exchange/machine.jsonc",
                "exodus": { "enabled": true, "path": "/hermes/calibrate" }
            },
            {
                "localized_name": "手套可视化",
                "name": "glove_visualize",
                "command": "python scripts/hermes/glove_visualize.py --hands both -c /exchange/machine.jsonc",
                "exodus": { "enabled": true, "path": "/glove/visualize" }
            }
        ],
        "cpu_alloc": { "collector": 0.8, "reserved": 0.1 },
        "docker": {
            "gpu": true,
            "params": { "shm_size": "2g" },
            "volumes": {
                "/var/.rdc2": { "bind": "/root/.rdc2", "mode": "rw" }
            }
        },
        "nodes": {
            "main": "python scripts/launch_hermes.py -c /exchange/machine.jsonc"
        }
    },
    "commander": {
        "unit": "hermes",
        "gello": {
            "wuji_glove_l": { "gello_type": "wuji_glove", "hand_type": "left", "polling_rate": 100 },
            "wuji_glove_r": { "gello_type": "wuji_glove", "hand_type": "right", "polling_rate": 100 }
        }
    },
    "misc": {
        "computer_id": "szx3-001",
        "machine_id": "szx3-001-hermes"
    },
    "storage": {
        "data": "/exchange/data_sink",
        "log": "/exchange/data_sink/logs",
        "tmp": "/exchange/scratch_space",
        "format": { "mcap_stream": true, "mcap_video": "av1" }
    },
    "vst": {
        "fps": 60,
        "height": 960,
        "path": "usb",
        "width": 1280
    }
}
```

### 1.4 示例解读

这台机器是 **`szx3-001-hermes`**(主机编号 `szx3-001`),具体配置读出来是:

- **采集程序**(`collector`):运行 `rdc-exodus` 类型的采集程序,工作流为 `hermes`;随附两个辅助工具——"机器全套标定"和"手套可视化";程序在带 GPU 的容器里运行,八成 CPU 分配给采集(`cpu_alloc.collector: 0.8`)。
- **操控设备**(`commander`):`hermes` 遥操作套件,配左右两只"无极"数据手套,每秒采样 100 次(`polling_rate: 100`)。
- **画面来源**(`cameras`):使用 Quest 头显的左右眼透视画面(`vst_left` / `vst_right`),通过 USB 连接。
- **录制**(`storage` + `vst`):数据录成 MCAP 文件、视频用 AV1 编码,存放在 `/exchange/data_sink`;透视视频为 1280×960、每秒 60 帧。

---

## 2. 查询当前任务信息

### 2.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/api/config/task` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5025/api/config/task` |
| 参数 | 无 |
| 返回 | 这台机器当前正在执行的任务(JSON);当前没有任务时返回空内容 `{}` |

### 2.2 返回内容说明

返回内容分三层:**任务本身**、**任务模板**(`template`,即"这项任务要做什么"的说明书)、**操作员**(`operator`,即正在做这项任务的人)。

**第一层:任务本身**

| 字段 | 含义 |
| --- | --- |
| `id` | 本次任务的唯一编号 |
| `hours` | 本次任务计划采集的小时数 |
| `hours_completed` | 已完成的小时数 |
| `create_time` | 任务创建时间(UTC 时间,北京时间需 +8 小时) |
| `state` | 任务状态,`active` 表示进行中 |
| `end_time` | 任务结束时间,未结束时为空(`null`) |
| `template_id` / `operator_id` / `order_id` | 关联的模板、操作员、订单的编号 |

**第二层:`template`(任务内容)**

| 字段 | 含义 |
| --- | --- |
| `name` | 任务名称(内部编号名) |
| `ref_name` | 任务的中文名称 |
| `description` | 任务的文字描述(可能为空) |
| `initial_states` | 开始前各物品的摆放要求 |
| `steps.payload` | 操作步骤清单,逐条列出操作员要做的动作 |
| `final_states` | 完成后各物品应处的状态 |
| `hours_target` | 该任务模板总共需要采集的小时数 |
| `verbs` / `objects` | 该任务涉及的动作词和物品清单 |
| `is_training` | 是否为培训任务 |
| `demo_urls` | 示范视频的文件位置 |

**第三层:`operator`(操作员)**

| 字段 | 含义 |
| --- | --- |
| `name` | 操作员姓名 |
| `level` | 操作员等级 |
| `email` | 操作员邮箱 |
| `state` | 账号状态,`active` 表示在职/可用 |

### 2.3 真实返回示例

```json
{
    "id": "3b6f542b-2c63-4ff4-833b-914d3046c72f",
    "template_id": "203affaf-450d-4bbc-b237-b4c42d16ee55",
    "hours": 4.0,
    "create_time": "2026-09-04T02:55:05.893511Z",
    "operator_id": "b9140f8d-f9b8-4d4a-bf6d-f0109c9104ac",
    "order_id": "9eb68011-6c36-4c59-9e96-8a70bfc166b3",
    "end_time": null,
    "hours_completed": 0.0,
    "state": "active",
    "template": {
        "id": "203affaf-450d-4bbc-b237-b4c42d16ee55",
        "project_id": "4c2088db-8e3e-43ed-974a-88c9b92615e0",
        "name": "ZPG-2-56-3-Stretch band around markers ",
        "description": null,
        "initial_states": {
            "states": {
                "marker (10x)": "Randomly placed on the table within reach.",
                "pen holder (2x)": "Randomly placed on the table within reach, empty.",
                "rubber band (2x)": "Hung on the key rack.",
                "key rack (1x)": "Randomly placed within the reachable range of the table."
            },
            "object_ids": {
                "marker": "bf96e007-e81d-4bd3-ba39-f69baffffc50",
                "pen holder": "5deec081-0783-4b8a-b7d5-40bc4bbcb20e",
                "rubber band": "31f32d07-70ac-4574-9aa5-36556ec24d63",
                "key rack": "04c3d82f-e60a-4eec-8342-28c3cdbe7e10"
            }
        },
        "steps": {
            "payload": [
                "Pick up one rubber band from the key rack with the nearest hand.",
                "Stretch the rubber band open with both hands.",
                "Release one hand from the rubber band, keeping the band stretched with the other hand.",
                "Pick up one marker with the nearest hand.",
                "Pick up a second marker and hold both markers together in one hand.",
                "Repeat Step 5 until holding 5 markers in one hand.",
                "Insert the markers into the stretched rubber band.",
                "Slide the rubber band to the center of the markers.",
                "Release the rubber band to secure the marker bundle.",
                "Place the marker bundle into one pen holder.",
                "Repeat Steps 1-10 until all 10 markers are bundled in groups of five and placed into different pen holders."
            ]
        },
        "final_states": {
            "states": {
                "marker (10x)": "Bundled into 2 groups, each group of 5 secured with a rubber band, placed in two pen holders.",
                "pen holder (2x)": "Same position as initial state, each containing 1 marker bundle.",
                "rubber band (2x)": "Wrapped around each marker bundle.",
                "key rack (1x)": "Same position as initial state, empty."
            },
            "object_ids": {
                "marker": "bf96e007-e81d-4bd3-ba39-f69baffffc50",
                "pen holder": "5deec081-0783-4b8a-b7d5-40bc4bbcb20e",
                "rubber band": "31f32d07-70ac-4574-9aa5-36556ec24d63",
                "key rack": "04c3d82f-e60a-4eec-8342-28c3cdbe7e10"
            }
        },
        "hours_target": 20.0,
        "hours_assigned": 0.0,
        "hours_completed": 0.0,
        "state": "active",
        "verbs": ["pick", "hold", "place", "stretch", "release", "slide"],
        "objects": ["rubber band", "marker", "pen holder", "key rack"],
        "is_training": false,
        "ref_name": "用弹力带捆扎马克笔",
        "demo_urls": ["demos/production/绑马克笔-手套_2677eb8f.mp4"]
    },
    "operator": {
        "id": "b9140f8d-f9b8-4d4a-bf6d-f0109c9104ac",
        "name": "SZX - Xiaofeng Yao",
        "localized_name": null,
        "level": 1,
        "email": "14093*****@qq.com",
        "state": "active"
    }
}
```

### 2.4 示例解读

查询这一刻,机器上正在进行的任务是:

- **做什么**:任务"**用弹力带捆扎马克笔**"(内部编号名 `ZPG-2-56-3-Stretch band around markers`)。开始前桌上随机摆着 10 支马克笔、2 个空笔筒、1 个挂架,挂架上挂 2 根皮筋(`initial_states`);操作员按 `steps.payload` 的 11 个步骤,把马克笔每 5 支一组用皮筋捆好、放进笔筒;完成后应是两捆各 5 支、分放在两个笔筒里(`final_states`)。
- **进度**:本次任务计划采集 4 小时(`hours: 4.0`),目前已完成 0 小时(`hours_completed: 0.0`)、状态进行中(`state: "active"`)——也就是刚开始。整个任务模板的总目标是 20 小时(`hours_target`)。
- **谁在做**:操作员 **Xiaofeng Yao**(深圳站点,等级 1,账号状态正常)。
- **时间**:任务创建于 UTC 时间 `2026-09-04 02:55`,即北京时间 9 月 4 日上午 10:55;`end_time` 为空,说明尚未结束。
- **其他**:`is_training: false` 表示这是正式采集而非培训;`demo_urls` 里有一个示范视频("绑马克笔-手套")供操作员参考。

---

## 常见问题

- **打开网址没有反应?** 请确认电脑与采集机在同一网络内,且地址和端口 `5025` 输入正确。
- **任务信息是空的 `{}`?** 说明这台机器当前没有正在执行的任务,属于正常现象。
- **时间看起来"快了"?** 返回中的时间均为 UTC(世界标准时间),换算成北京时间需加 8 小时。
