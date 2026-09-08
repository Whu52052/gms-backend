# 采集程序状态查询接口说明(RDC2 Hermes API)

本文档介绍如何从采集机上运行的**采集程序(RDC2 Hermes)**读取程序版本、设备健康状况、
实时工作状态和摄像头清单。内容面向非技术读者,只涉及"查询/读取"类接口,不涉及任何控制操作。

每个接口按同一顺序介绍:**接口规格 → 返回内容说明 → 真实返回示例 → 示例解读**。
文中的真实示例均取自机器 `we-001.szx3.worldengine.ai` 的实际返回,取样时该机器**正在录制**。

> 说明:本接口(端口 5006)只提供采集程序自身的**运行状态**;机器配置与当前任务的
> 详细信息由另一个服务(Importer,端口 5025)提供,见《采集机信息查询接口说明(Importer API)》。

## 基本信息

- **访问地址**:`http://<采集机地址>:5006`,例如 `http://we-001.szx3.worldengine.ai:5006`
- **访问方式**:普通的 HTTP GET 请求。在浏览器地址栏输入完整网址即可查看,无需安装任何软件。
- **返回格式**:JSON(一种通用的结构化文本格式,浏览器可直接显示)

---

## 1. 查询程序版本

### 1.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/version` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5006/version` |
| 参数 | 无 |
| 返回 | 采集程序的版本号(JSON) |

### 1.2 返回内容说明

| 字段 | 含义 |
| --- | --- |
| `content.version` | 采集程序的版本号 |
| `timestamp` | 本次查询的时间 |
| `status` | 固定为 `0`,表示查询成功 |

### 1.3 真实返回示例

```json
{
    "status": 0,
    "timestamp": "2026-09-04T03:51:08.431010",
    "content": { "version": "2.15.1" }
}
```

### 1.4 示例解读

这台机器上运行的采集程序版本是 **2.15.1**。

---

## 2. 查询设备健康状况

### 2.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/health` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5006/health` |
| 参数 | 无 |
| 返回 | 采集程序是否在线,以及机器上每个部件(摄像头、手套、头显等)的连接状况 |

### 2.2 返回内容说明

| 字段 | 含义 |
| --- | --- |
| `status` | 只要能打开这个网址就是 `ok`,表示采集程序进程在线(某个部件故障不会改变它) |
| `timestamp` | 本次查询的时间(POSIX 秒) |
| `components` | 各个部件的清单。每一项包含:`kind`(部件类型)、`status`(`connected` 表示已连接)、`age_s`(距上次收到该部件数据过了几秒)、`ever_seen`(开机以来是否收到过数据) |
| `degraded` | 有问题的部件名单;空列表 `[]` 表示没有 |
| `all_connected` | 是否所有部件都已连接,`true` 表示全部正常 |
| `errors` | 当前的错误列表;空列表 `[]` 表示没有错误 |

常见部件名:`camera/…` 是摄像头(`vst_left`/`vst_right` 头显左右眼、`wrist_left`/`wrist_right` 左右手腕、`overlay` 合成画面),`robot/…` 与 `gello/…` 是左右数据手套,`quest/overlay` 是 Quest 头显。

### 2.3 真实返回示例

```json
{
    "status": "ok",
    "timestamp": 1788493858.667969,
    "components": {
        "robot/wuji_glove_r": { "kind": "robot", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "camera/wrist_right": { "kind": "camera", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "quest/overlay": { "kind": "quest", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "camera/wrist_left": { "kind": "camera", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "robot/wuji_glove_l": { "kind": "robot", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "camera/overlay": { "kind": "camera", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "camera/vst_right": { "kind": "camera", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "camera/vst_left": { "kind": "camera", "status": "connected", "age_s": 0.0, "ever_seen": true },
        "gello/wuji_glove_l": { "kind": "gello", "status": "connected" },
        "gello/wuji_glove_r": { "kind": "gello", "status": "connected" }
    },
    "degraded": [],
    "all_connected": true,
    "errors": []
}
```

### 2.4 示例解读

采集程序在线(`status: "ok"`),机器上的全部 10 个部件——5 路摄像头(头显左右眼、左右手腕、合成画面)、左右两只数据手套、Quest 头显——都处于已连接状态,刚刚都还在传数据(`age_s: 0.0`)。没有降级的部件、没有错误,`all_connected: true` 说明整机健康。

---

## 3. 查询实时工作状态

### 3.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/state` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5006/state` |
| 参数 | 无 |
| 返回 | 机器此刻的工作状态快照:是否在录制、各部件健康摘要、手套/头显的实时数据等 |

### 3.2 返回内容说明

返回是一份"状态条目清单"(`robots.robot_1` 下的列表),每个条目是
`{topic(名称), data_type(数据类型), data(数值)}`。常用条目:

| 条目(topic) | 含义 |
| --- | --- |
| `control_state` | 机器的工作阶段。常见值:`BOOT` 启动中、`INIT` 自检/准备中、`ALIGN` 对齐中、`ACTIVE` 就绪(可开始录制)、`RECORD` 正在录制、`STOPPED` 已停止 |
| `is_recording` | 是否正在录制,`true`/`false` |
| `is_emergency_stopped` | 是否处于急停,正常为 `false` |
| `glove_left/joints`、`glove_right/joints` | 左/右手套 20 个关节的实时角度(弧度),供技术人员核对手套是否在动 |
| `health/summary/…` | 各部件的健康摘要(`connected` 已连接;录制器 `recorder` 为 `ready` 表示预热完毕) |
| `health/glove/…/tactile` | 手套各指触觉传感器的健康比例(0~1),对应摘要 `good` 表示良好 |
| `quest/headset_connected`、`quest/…/tracked` | 头显是否连接、头部与左右手柄是否被正常追踪 |
| `quest/…/pose` | 头部/手柄的实时空间位置(7 个数:位置 x/y/z + 朝向四元数) |
| `error_count`、`errors` | 当前错误数量与错误列表,`0` / `[]` 表示无错误 |

### 3.3 真实返回示例

```json
{
    "timestamp_posix": 1788493867.8598988,
    "robots": {
        "robot_1": [
            { "topic": "control_state", "data_type": "string", "data": "RECORD" },
            { "topic": "control_state_description", "data_type": "string", "data": "control_state/desc/record" },
            { "topic": "is_recording", "data_type": "boolean", "data": true },
            { "topic": "is_emergency_stopped", "data_type": "boolean", "data": false },
            { "topic": "teleop_aligned", "data_type": "boolean", "data": true },
            { "topic": "glove_left/joints", "data_type": "array", "data": [-0.27226859298047035, 0.3252441193744555, -0.9162918324183164, -1.127916312919126, -0.5185152765639129, 0.26042320574292976, -0.00872664625997165, -1.4437234276246291, -0.9192441041170233, -0.08585144082486558, -1.0247520367804084, -0.7524282596306625, -1.351711060710346, -0.2885322755974327, -0.9223741064057585, -0.7139623026847935, -0.9705736555419567, 0.0863726576077079, -0.9477865457059409, -0.8745574829648891] },
            { "topic": "glove_right/joints", "data_type": "array", "data": [0.7524884599774462, -0.13692091454648544, -1.010086815599538, 0.11278136340648101, 0.6552681339399175, -0.18770956035541345, 0.5216831145716898, 0.7194827806731399, 0.8601031044950193, -0.1470988622315701, 0.6829871878464004, 0.6338028299282155, 0.6685438657600379, 0.08871430248694254, 0.6453343961339332, 0.6264461122440835, 0.19055767959967804, 0.42469569096958504, 0.6285211254760069, 0.7385075828689075] },
            { "topic": "health/hand/left", "data_type": "string", "data": "connected" },
            { "topic": "health/hand/right", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/quest", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/wrist_left", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/wrist_right", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/glove_left", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/glove_right", "data_type": "string", "data": "connected" },
            { "topic": "health/summary/recorder", "data_type": "string", "data": "ready" },
            { "topic": "health/all_connected", "data_type": "boolean", "data": true },
            { "topic": "health/glove/left/tactile", "data_type": "json", "data": { "index": 0.556, "middle": 0.817, "palm": 0.581, "pinky": 0.709, "ring": 0.648, "thumb": 0.42 } },
            { "topic": "health/summary/glove/tactile/left", "data_type": "string", "data": "good" },
            { "topic": "health/glove/right/tactile", "data_type": "json", "data": { "index": 0.533, "middle": 0.383, "palm": 0.289, "pinky": 0.618, "ring": 0.259, "thumb": 0.2 } },
            { "topic": "health/summary/glove/tactile/right", "data_type": "string", "data": "good" },
            { "topic": "quest/headset_connected", "data_type": "boolean", "data": true },
            { "topic": "quest/starlight", "data_type": "boolean", "data": true },
            { "topic": "quest/head/tracked", "data_type": "boolean", "data": true },
            { "topic": "quest/head/pose", "data_type": "array", "data": [-0.00068, -0.00135, 0.00088, -0.406087, 0.003671, 0.00882, 0.913785] },
            { "topic": "quest/left_controller/tracked", "data_type": "boolean", "data": true },
            { "topic": "quest/left_controller/pose", "data_type": "array", "data": [-0.26673, -0.7005, -0.27594, -0.225418, 0.212057, 0.26296, -0.913822] },
            { "topic": "quest/right_controller/tracked", "data_type": "boolean", "data": true },
            { "topic": "quest/right_controller/pose", "data_type": "array", "data": [0.13779, -0.70414, -0.27769, 0.566693, 0.400487, -0.087668, 0.714692] },
            { "topic": "error_count", "data_type": "float", "data": 0.0 },
            { "topic": "errors", "data_type": "json", "data": [] }
        ]
    }
}
```

### 3.4 示例解读

查询这一刻,这台机器**正在录制一段数据**:

- **工作阶段**:`control_state: "RECORD"`、`is_recording: true` —— 正在录制;没有急停(`is_emergency_stopped: false`)。
- **设备健康**:左右手套、头显、左右手腕摄像头全部 `connected`,录制器 `ready`(预热完毕),`health/all_connected: true` —— 整机就绪。
- **手套在动**:`glove_left/joints` 和 `glove_right/joints` 各给出 20 个关节的实时角度,数值在变化说明操作员的手正在活动。
- **触觉传感器**:左右手套各手指的触觉健康比例均在正常范围,两只手的摘要都是 `good`。
- **头显追踪**:头显已连接,头部和左右手柄都被正常追踪(三个 `tracked: true`),并各自给出实时空间位置。
- **无错误**:`error_count: 0`、`errors: []`。

---

## 4. 查询摄像头/传感器清单

### 4.1 接口规格

| 项目 | 内容 |
| --- | --- |
| 方法 | GET |
| 路径 | `/sensors` |
| 完整示例地址 | `http://we-001.szx3.worldengine.ai:5006/sensors` |
| 参数 | 无 |
| 返回 | 这台机器可供查看/录制的画面与传感器清单 |

### 4.2 返回内容说明

返回一个列表,每项是一路画面或传感器:

| 字段 | 含义 |
| --- | --- |
| `id` | 名称:`vst_left`/`vst_right` 头显左右眼、`wrist_left`/`wrist_right` 左右手腕摄像头、`overlay` 合成画面(真实画面上叠加重建的手)、`…_tactile` 手套触觉 |
| `data_type` | 数据种类:`video/x-motion-jpeg` 是视频画面,`exodus/wuji_glove` 是手套触觉数据 |
| `width` / `height` | 该路画面的录制分辨率 |
| `codecs` | 支持的视频编码方式(供技术人员参考) |

### 4.3 真实返回示例

```json
[
    { "id": "overlay", "data_type": "video/x-motion-jpeg", "codecs": ["h264", "av1", "h265", "mjpeg"], "width": 1280, "height": 960 },
    { "id": "vst_left", "data_type": "video/x-motion-jpeg", "codecs": ["h264", "av1", "h265", "mjpeg"], "width": 1280, "height": 1280 },
    { "id": "vst_right", "data_type": "video/x-motion-jpeg", "codecs": ["h264", "av1", "h265", "mjpeg"], "width": 1280, "height": 1280 },
    { "id": "wrist_left", "data_type": "video/x-motion-jpeg", "codecs": ["h264", "av1", "h265", "mjpeg"], "width": 1280, "height": 720 },
    { "id": "wrist_right", "data_type": "video/x-motion-jpeg", "codecs": ["h264", "av1", "h265", "mjpeg"], "width": 1280, "height": 720 },
    { "id": "wuji_glove_l_tactile", "data_type": "exodus/wuji_glove", "side": "left" },
    { "id": "wuji_glove_r_tactile", "data_type": "exodus/wuji_glove", "side": "right" }
]
```

### 4.4 示例解读

这台机器提供 **5 路视频画面**和 **2 路触觉数据**:

- 头显左右眼画面 `vst_left` / `vst_right`(各 1280×1280);
- 左右手腕摄像头 `wrist_left` / `wrist_right`(各 1280×720);
- 合成画面 `overlay`(1280×960)——在真实画面上叠加了重建的手部模型,是审看录制质量时最常看的一路;
- 左右手套的触觉数据 `wuji_glove_l_tactile` / `wuji_glove_r_tactile`。

---

## 5. 实时推送(可选,供开发人员参考)

如果希望状态更新时自动收到,而不是反复刷新,可以使用 WebSocket 版本的地址:

- 工作状态:`ws://<采集机地址>:5006/ws/state`(约每秒推送 30 次)
- 设备健康:`ws://<采集机地址>:5006/ws/health`(状态变化时推送)

这一部分需要开发人员编写少量程序才能使用,普通查看请用上面第 1~4 节的网址。

---

## 常见问题

- **打开网址没有反应?** 请确认电脑与采集机在同一网络内,且地址和端口 `5006` 输入正确;另外机器上的采集程序须在运行中(标定等辅助工具占用同一端口时,主程序接口暂不可用)。
- **想看机器配置或当前任务?** 用 Importer 服务(端口 `5025`)的接口,见《采集机信息查询接口说明(Importer API)》。
- **`/health` 的 `status` 一直是 `ok`,部件坏了也不变?** 是的,`status` 只回答"采集程序进程是否在线";部件问题看 `components`、`degraded` 和 `all_connected`。
