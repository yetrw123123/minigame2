const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const {
  init: initDB,
  Counter,
  GameSave,
  ShareInvite,
  DailyRank,
  recordShareInvite,
  getInviteCount,
  trimTodayRank,
  getBeijingDateString  // 从 db.js 导入
} = require("./db");
const { Op } = require("sequelize");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 在顶部添加这个声明
let isCleaning = false;
let lastCleanupDay = null;

// 每日清理函数
function setupDailyCleanup() {
  console.log('设置每日零点清理任务...');
  
  // 每分钟检查一次
  setInterval(async () => {
    const today = getBeijingDateString();
    const beijingHour = getBeijingHour();
    
    // 如果是凌晨0点，且今天还没清理过
    if (beijingHour === 0 && lastCleanupDay !== today) {
      console.log(`[${new Date().toISOString()}] 北京时间零点，执行清理`);
      lastCleanupDay = today;
      await cleanupOldRanks();
      
      // 清理后立即修剪今日排行榜
      await trimTodayRank(today);
    }
  }, 60 * 1000);
  
  // 服务器启动后立即检查一次
  setTimeout(async () => {
    console.log('服务器启动，执行首次数据检查...');
    await cleanupOldRanks();
    lastCleanupDay = getBeijingDateString();
    
    // 启动时也修剪一下今日排行榜
    const today = getBeijingDateString();
    await trimTodayRank(today);
  }, 10000);
  
  // 每5分钟修剪一次今日排行榜（防止数据过多）
  setInterval(async () => {
    const today = getBeijingDateString();
    await trimTodayRank(today);
  }, 5 * 60 * 1000);
}

/**
 * 获取北京时间的小时数
 */
function getBeijingHour() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour + 8) % 24; // 北京=UTC+8
}

// 清理旧数据函数
async function cleanupOldRanks() {
  // 防止重复执行
  if (isCleaning) {
    console.log('清理任务正在运行，跳过本次执行');
    return;
  }
  
  isCleaning = true;
  
  try {
    const today = getBeijingDateString();
    const result = await DailyRank.destroy({
      where: {
        recordDate: { [Op.ne]: today }
      }
    });
    
    if (result > 0) {
      console.log(`[${new Date().toISOString()}] 清理了 ${result} 条旧排行榜数据`);
    } else {
      console.log(`[${new Date().toISOString()}] 没有需要清理的旧数据`);
    }
  } catch (error) {
    console.error('清理旧数据失败:', error);
  } finally {
    isCleaning = false;
  }
}

/**
 * 获取玩家在今日排行榜中的排名
 * 如果不在前100名内，返回null
 */
async function getPlayerRank(openid, today) {
  try {
    // 获取今日前100名
    const top100 = await DailyRank.findAll({
      where: { recordDate: today },
      order: [
        ['instanceID', 'DESC'],
        ['createdAt', 'ASC']
      ],
      limit: 100
    });
    
    // 查找玩家在列表中的位置
    const playerIndex = top100.findIndex(record => record.openid === openid);
    
    if (playerIndex === -1) {
      return null; // 未上榜
    }
    
    // 处理同分情况
    const playerScore = top100[playerIndex].instanceID;
    const playerCreatedAt = top100[playerIndex].createdAt;
    
    // 计算比玩家分数高的记录数
    let higherCount = 0;
    for (const record of top100) {
      if (record.instanceID > playerScore) {
        higherCount++;
      } else if (record.instanceID === playerScore && 
                 new Date(record.createdAt) < new Date(playerCreatedAt)) {
        // 同分但创建时间更早
        higherCount++;
      } else {
        break; // 后面的记录分数不会更高
      }
    }
    
    return higherCount + 1;
  } catch (error) {
    console.error('计算排名失败:', error);
    return null;
  }
}

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
    const [record, created] = await GameSave.upsert({
      openid: openid,
      gameData: JSON.stringify(gameData),
      updatedAt: new Date()
    }, {
      returning: true
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
    const record = await GameSave.findByPk(openid);

    if (record) {
      res.send({
        code: 0,
        message: "存档加载成功",
        data: {
          hasData: true,
          gameData: JSON.parse(record.gameData),
          updatedAt: record.updatedAt
        }
      });
    } else {
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
  const {inviteeOpenId, inviterOpenId, scene } = req.body;
  
  if (!inviterOpenId) {
    return res.send({ code: 401, message: "未获取到分享者身份" });
  }
  if (!inviteeOpenId) {
    return res.send({ code: 400, message: "缺少被邀请者信息" });
  }
  
  if (inviterOpenId === inviteeOpenId) {
    return res.send({ code: 400, message: "不能邀请自己" });
  }

  try {
    const invite = await recordShareInvite(inviterOpenId, inviteeOpenId, { scene });
    
    if (invite) {
      const totalInvites = await getInviteCount(inviterOpenId);
      
      res.send({ 
        code: 0, 
        message: "分享记录成功",
        data: {
          inviteId: invite.id,
          totalInvites: totalInvites,
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
  const openid = req.headers["x-wx-openid"];
  
  if (!openid) {
    return res.send({ code: 401, message: "未获取到用户身份" });
  }

  try {
    const inviteCount = await getInviteCount(openid);
    
    const inviteList = await ShareInvite.findAll({
      where: {
        inviterOpenId: openid,
        status: 'completed'
      },
      attributes: ['id', 'inviteeOpenId', 'createdAt', 'extraInfo'],
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    
    res.send({
      code: 0,
      message: "获取分享数据成功",
      data: {
        inviterOpenId: openid,
        totalInvites: inviteCount,
        inviteList: inviteList.map(item => ({
          id: item.id,
          inviteeOpenId: item.inviteeOpenId.substring(0, 8) + '...',
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

// ============ 获取服务器当前日期接口 ============
app.get("/api/current_date", async (req, res) => {
  try {
    const now = new Date();
    
    res.send({
      code: 0,
      message: "success",
      data: {
        iso: now.toISOString(),          
        date: getBeijingDateString(),
        local: now.toString(),            
        timestamp: now.getTime(),         
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        dayOfWeek: now.getDay()
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

// ============ 每日排行榜接口 ============

// 接口1：上传/更新成绩
app.post("/api/rank/submit", async (req, res) => {
  const openid = req.headers["x-wx-openid"];
  const { playerName, instanceID, roleID = 1 } = req.body;

  if (!openid) {
    return res.status(401).json({ 
      code: 401, 
      message: "未获取到用户身份" 
    });
  }
  if (!playerName || playerName.trim() === '') {
    return res.status(400).json({ 
      code: 400, 
      message: "玩家名字不能为空" 
    });
  }
  if (typeof instanceID !== 'number' || instanceID < 0) {
    return res.status(400).json({ 
      code: 400, 
      message: "instanceID 必须为非负数字" 
    });
  }

  try {
    const beijingDateToday = getBeijingDateString();
    const now = new Date();

    // 检查玩家今日是否已有记录
    const existingRecord = await DailyRank.findOne({
      where: {
        openid: openid,
        recordDate: beijingDateToday
      }
    });

    let record;
    let isNew = false;
    
    if (existingRecord) {
      // 只保留更高的分数
      if (instanceID > existingRecord.instanceID) {
        await existingRecord.update({
          playerName: playerName.trim(),
          roleID: roleID,
          instanceID: instanceID
        });
        record = existingRecord;
      } else {
        // 分数没超过，不更新
        return res.json({
          code: 0,
          message: "分数未超过当前记录，不更新",
          data: {
            playerName: existingRecord.playerName,
            roleID: existingRecord.roleID,
            instanceID: existingRecord.instanceID,
            date: existingRecord.recordDate,
            isUpdated: false
          }
        });
      }
    } else {
      // 创建新记录
      record = await DailyRank.create({
        openid: openid,
        recordDate: beijingDateToday,
        playerName: playerName.trim(),
        roleID: roleID,
        instanceID: instanceID
      });
      isNew = true;
    }

    // 修剪排行榜，只保留前100名
    await trimTodayRank(beijingDateToday);
    
    // 计算当前排名
    const rank = await getPlayerRank(openid, beijingDateToday);

    console.log(`[${beijingDateToday}] 玩家 ${playerName} (角色${roleID}) ${isNew ? '创建' : '更新'}了成绩: ${instanceID}, 排名: ${rank || '未上榜'}`);
    
    res.json({
      code: 0,
      message: isNew ? "成绩已记录" : "成绩已更新",
      data: {
        playerName: record.playerName,
        roleID: record.roleID,
        instanceID: record.instanceID,
        rank: rank, // null表示未上榜
        isOnRank: rank !== null,
        date: record.recordDate
      }
    });

  } catch (error) {
    console.error('提交排行榜失败:', error);
    res.status(500).json({ 
      code: 500, 
      message: "提交成绩失败"
    });
  }
});

// 接口2：获取今日排行榜（前100名）
app.get("/api/rank/list", async (req, res) => {
  const openid = req.headers["x-wx-openid"];
  const beijingDateToday = getBeijingDateString();

  try {
    // 获取今日排行榜前100名
    const rankList = await DailyRank.findAll({
      where: { 
        recordDate: beijingDateToday
      },
      order: [
        ['instanceID', 'DESC'],
        ['createdAt', 'ASC'] // 同分按创建时间排序
      ],
      limit: 100
    });

    // 处理数据
    const processedList = rankList.map((item, index) => ({
      rank: index + 1,
      playerName: item.playerName,
      roleID: item.roleID,
      instanceID: item.instanceID,
      isSelf: openid && item.openid === openid
    }));

    // 计算当前玩家排名
    let myRank = null;
    let myScore = null;
    let myRoleID = null;
    if (openid) {
      const playerIndex = rankList.findIndex(item => item.openid === openid);
      if (playerIndex !== -1) {
        myRank = playerIndex + 1;
        myScore = rankList[playerIndex].instanceID;
        myRoleID = rankList[playerIndex].roleID;
      }
    }

    res.json({
      code: 0,
      message: "获取排行榜成功",
      data: {
        list: processedList,
        myRank: myRank, // null表示未上榜
        myScore: myScore,
        myRoleID: myRoleID,
        date: beijingDateToday
      }
    });

  } catch (error) {
    console.error('获取排行榜失败:', error);
    res.status(500).json({ 
      code: 500, 
      message: "获取排行榜失败"
    });
  }
});

// 接口3：获取玩家自己数据
app.get("/api/rank/my", async (req, res) => {
  const openid = req.headers["x-wx-openid"];
  const beijingDateToday = getBeijingDateString();

  if (!openid) {
    return res.status(401).json({ 
      code: 401, 
      message: "未获取到用户身份" 
    });
  }

  try {
    // 获取玩家今日记录
    const playerRecord = await DailyRank.findOne({
      where: { 
        openid: openid,
        recordDate: beijingDateToday 
      }
    });

    if (!playerRecord) {
      // 玩家今日未上榜
      return res.json({
        code: 0,
        data: {
          onRank: false,
          message: "今日未上榜",
          date: beijingDateToday
        }
      });
    }

    // 计算排名
    const rank = await getPlayerRank(openid, beijingDateToday);
    
    if (rank === null) {
      // 不在前100名内
      return res.json({
        code: 0,
        data: {
          onRank: false,
          score: playerRecord.instanceID,
          playerName: playerRecord.playerName,
          roleID: playerRecord.roleID,
          message: "未进入前100名",
          date: beijingDateToday
        }
      });
    }

    // 返回上榜数据
    res.json({
      code: 0,
      data: {
        onRank: true,
        rank: rank,
        score: playerRecord.instanceID,
        playerName: playerRecord.playerName,
        roleID: playerRecord.roleID,
        date: beijingDateToday
      }
    });

  } catch (error) {
    console.error('查询个人排名失败:', error);
    res.status(500).json({ 
      code: 500, 
      message: "查询失败"
    });
  }
});

// 新增接口：获取排行榜统计信息（调试用）
app.get("/api/rank/stats", async (req, res) => {
  const beijingDateToday = getBeijingDateString();
  
  try {
    // 获取今日记录总数
    const totalCount = await DailyRank.count({
      where: { recordDate: beijingDateToday }
    });
    
    // 获取前100名的最低分数
    const rankList = await DailyRank.findAll({
      where: { recordDate: beijingDateToday },
      order: [['instanceID', 'DESC']],
      limit: 100
    });
    
    const minScoreInTop100 = rankList.length > 0 ? rankList[rankList.length - 1].instanceID : 0;
    
    res.json({
      code: 0,
      data: {
        date: beijingDateToday,
        totalPlayers: totalCount,
        top100MinScore: minScoreInTop100,
        top100Count: Math.min(100, totalCount)
      }
    });
  } catch (error) {
    console.error('获取排行榜统计失败:', error);
    res.status(500).json({ 
      code: 500, 
      message: "获取统计失败"
    });
  }
});

// ============ 自定义接口 END ============

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();

  // 设置每日凌晨的清理任务
  setupDailyCleanup();

  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("当前北京时间:", getBeijingDateString());
  });
}

bootstrap();