const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const {
  init: initDB,
  Counter,
  GameSave,
  ShareInvite,
  recordShareInvite,
  getInviteCount
} = require("./db");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({
      truncate: true,
    });
  }
  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
  else {
    // 非小程序环境或无效请求，返回错误信息
    res.status(400).send({ code: 400, message: "无效请求或非小程序环境" });
  }
});

// ============ 自定义接口 START ============
// 保存游戏存档接口
app.post("/api/save_data", async (req, res) => {
  const openid = req.headers["x-wx-openid"];
  const gameData = req.body;

  if (!openid) {
    return res.send({ code: 401, message: "未获取到用户身份" });
  }
  if (!gameData || typeof gameData !== 'object') {
    return res.send({ code: 400, message: "请求体数据无效" });
  }

  try {
    // 使用 upsert 方法：如果该 openid 的记录存在则更新，不存在则创建
    const [record, created] = await GameSave.upsert({
      openid: openid,
      gameData: JSON.stringify(gameData), // 将对象转为JSON字符串存储
      updatedAt: new Date()
    }, {
      returning: true // 返回操作后的记录
    });

    console.log(`用户 ${openid} 存档${created ? '新建' : '更新'}成功`);
    res.send({
      code: 0,
      message: "存档保存成功",
      data: { openid: openid }
    });
  } catch (error) {
    console.error('保存存档失败:', error);
    res.send({ code: 500, message: "服务器内部错误，保存失败" });
  }
});

// 读取游戏存档接口
app.get("/api/load_data", async (req, res) => {
  const openid = req.headers["x-wx-openid"];

  if (!openid) {
    return res.send({ code: 401, message: "未获取到用户身份" });
  }

  try {
    const record = await GameSave.findByPk(openid); // 用主键 openid 查找

    if (record) {
      // 找到存档，解析并返回
      res.send({
        code: 0,
        message: "存档加载成功",
        data: {
          hasData: true,
          gameData: JSON.parse(record.gameData), // 将字符串解析回对象
          updatedAt: record.updatedAt
        }
      });
    } else {
      // 没有找到存档，返回默认数据
      const defaultData = { gold: 100, instanceID: 0, items: [] };
      res.send({
        code: 0,
        message: "无存档，返回默认数据",
        data: {
          hasData: false,
          gameData: defaultData
        }
      });
    }
  } catch (error) {
    console.error('读取存档失败:', error);
    res.send({ code: 500, message: "服务器内部错误，读取失败" });
  }
});

app.post("/api/share/record", async (req, res) => {
  const {inviteeOpenId, inviterOpenId, scene } = req.body; // 受邀者OpenId，邀请者OpenId
  
  if (!inviterOpenId) {
    return res.send({ code: 401, message: "未获取到分享者身份" });
  }
  if (!inviteeOpenId) {
    return res.send({ code: 400, message: "缺少被邀请者信息" });
  }
  
  // 防止自己邀请自己
  if (inviterOpenId === inviteeOpenId) {
    return res.send({ code: 400, message: "不能邀请自己" });
  }

  try {
    const invite = await recordShareInvite(inviterOpenId, inviteeOpenId, { scene });
    
    if (invite) {
      // 这里需要添加缺失的 totalInvites 计算
      const totalInvites = await getInviteCount(inviterOpenId);
      
      res.send({ 
        code: 0, 
        message: "分享记录成功",
        data: {
          inviteId: invite.id,
          totalInvites: totalInvites, // 现在这个变量已定义
        }
      });
    } else {
      res.send({ 
        code: 2001,
        message: "该用户已被其他用户邀请过",
        data: null
      });
    }
  } catch (error) {
    console.error('记录分享失败:', error);
    res.send({ 
      code: 500, 
      message: "服务器内部错误，记录失败",
      error: error.message 
    });
  }
});

// 获取分享统计数据接口
app.get("/api/share/stats", async (req, res) => {
  const openid = req.headers["x-wx-openid"]; // 获取当前用户的openid
  
  if (!openid) {
    return res.send({ code: 401, message: "未获取到用户身份" });
  }

  try {
    // 获取该用户的总邀请人数
    const inviteCount = await getInviteCount(openid);
    
    // 可选：获取详细的邀请记录列表
    const inviteList = await ShareInvite.findAll({
      where: {
        inviterOpenId: openid,
        status: 'completed'
      },
      attributes: ['id', 'inviteeOpenId', 'createdAt', 'extraInfo'],
      order: [['createdAt', 'DESC']],
      limit: 50 // 限制返回数量
    });
    
    res.send({
      code: 0,
      message: "获取分享数据成功",
      data: {
        inviterOpenId: openid,
        totalInvites: inviteCount,
        inviteList: inviteList.map(item => ({
          id: item.id,
          inviteeOpenId: item.inviteeOpenId.substring(0, 8) + '...', // 隐藏部分ID保护隐私
          inviteDate: item.createdAt,
          scene: item.extraInfo ? JSON.parse(item.extraInfo).scene : null
        }))
      }
    });
  } catch (error) {
    console.error('获取分享统计失败:', error);
    res.send({ 
      code: 500, 
      message: "服务器内部错误，获取失败",
      error: error.message 
    });
  }
});

// ============ 新增：获取服务器当前日期接口 ============
app.get("/api/current_date", async (req, res) => {
  try {
    const now = new Date();
    
    // 返回多种格式，方便不同需求使用
    res.send({
      code: 0,
      message: "success",
      data: {
        // 标准ISO字符串，带时区信息
        iso: now.toISOString(),          
        // 简化日期字符串，适合用于“按天”比较（YYYY-MM-DD）
        date: now.toISOString().split('T')[0],
        // 本地时间字符串，便于阅读
        local: now.toString(),            
        // 时间戳（毫秒），精确比较
        timestamp: now.getTime(),         
        // 年、月、日单独字段，方便业务逻辑
        year: now.getFullYear(),
        month: now.getMonth() + 1,       // 月份从0开始，所以+1
        day: now.getDate(),
        dayOfWeek: now.getDay()          // 周日=0，周一=1，...
      }
    });
  } catch (error) {
    console.error('获取日期失败:', error);
    res.send({ 
    code: 500, 
    message: "获取服务器日期失败" 
  });
  }
});


// ============ 自定义接口 END ============

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();
