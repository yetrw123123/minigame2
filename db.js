const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql" /* one of 'mysql' | 'mariadb' | 'postgres' | 'mssql' */,
});

// 定义数据模型
const Counter = sequelize.define("Counter", {
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

// ============ 新增：定义游戏存档模型 ============
const GameSave = sequelize.define("GameSave", {
  // 使用微信OpenID作为主键，唯一标识一个用户
  openid: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true, // 设为主键
    unique: true,
  },
  // 使用 TEXT 类型存储复杂的游戏存档数据（改为更通用的TEXT）
  gameData: {
    type: DataTypes.TEXT, // 将 TEXT('long') 改为通用的 TEXT，兼容性更好
    allowNull: false,
    defaultValue: '{}',
  },
});

// ============ 新增：分享邀请记录模型 ============
const ShareInvite = sequelize.define("ShareInvite", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // 分享者（邀请人）的 OpenID
  inviterOpenId: {
    type: DataTypes.STRING,
    allowNull: false,
    // 注意：这里不设为主键，因为一个用户可以邀请多人
  },
  // 新用户（被邀请人）的 OpenID
  inviteeOpenId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true, // 一个用户只能被一个分享链接带入（业务逻辑假设）
  },
  // 邀请状态：用于扩展（例如 'pending', 'completed', 'reward_sent'）
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'completed',
  },
  // 额外信息，如分享场景、分享图ID等，存储为JSON字符串
  extraInfo: {
    type: DataTypes.TEXT,
    allowNull: true,
  }
}, {
  // 添加索引以优化查询
  indexes: [
    // 用于快速查找某个分享者的所有邀请
    {
      fields: ['inviterOpenId']
    },
    // 用于按时间排序查看
    {
      fields: ['createdAt']
    }
  ]
});


// ============ 新增：每日排行榜模型（含角色ID）============
const DailyRank = sequelize.define("DailyRank", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  playerName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // 角色ID，记录玩家使用的角色
  roleID: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1, // 假设默认角色ID为1
  },
  // 关卡进度ID
  instanceID: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // 玩家标识
  openid: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // 北京日期，用于每日清空
  recordDate: {
    type: DataTypes.STRING(10),
    allowNull: false,
    comment: '北京日期 (YYYY-MM-DD)'
  }
}, {
  indexes: [
    // 按 instanceID 排序（排行榜核心排序）
    {
      fields: ['instanceID']
    },
    // 按日期查询（用于每日清空）
    {
      fields: ['recordDate']
    }
  ]
});

// 数据库初始化方法
async function init() {
  try {
    // 同步两个模型到数据库
    await Counter.sync({ alter: true });
    console.log('Counter 表同步成功');
    
    await GameSave.sync({ alter: true }); 
    console.log('GameSave 表同步成功');

    await ShareInvite.sync({ alter: true });
    console.log('ShareInvite 表同步成功');

    await DailyRank.sync({ alter: true });
    console.log('DailyRank 表同步成功');
    
  } catch (error) {
    // 捕获并打印详细的错误信息
    console.error('数据库表同步失败，错误详情:');
    console.error('错误名称:', error.name);
    console.error('错误信息:', error.message);
    console.error('原始错误堆栈:', error);
    
    // 如果是Sequelize的验证错误，可以打印更多细节
    if (error.name === 'SequelizeValidationError' || error.name === 'SequelizeDatabaseError') {
      console.error('SQL 相关错误详情:', error.parent?.sqlMessage || error.sql);
    }
    // 可以选择让进程退出，这样云托管会显示部署失败，便于发现问题
    // process.exit(1);
  }
}

// 记录一次成功分享邀请
async function recordShareInvite(inviterOpenId, inviteeOpenId, extraInfo = null) {
  try {
    const invite = await ShareInvite.create({
      inviterOpenId,
      inviteeOpenId,
      extraInfo: extraInfo ? JSON.stringify(extraInfo) : null
    });
    console.log(`分享记录创建成功，ID: ${invite.id}`);
    return invite;
  } catch (error) {
    // 处理唯一约束冲突（同一用户被重复记录）
    if (error.name === 'SequelizeUniqueConstraintError') {
      console.warn(`用户 ${inviteeOpenId} 已被其他用户邀请过`);
      return null;
    }
    throw error;
  }
}

// 查询某个分享者的成功邀请数量
async function getInviteCount(inviterOpenId) {
  return await ShareInvite.count({
    where: {
      inviterOpenId,
      status: 'completed' // 只统计成功的邀请
    }
  });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Counter,
  GameSave,
  ShareInvite,
  DailyRank,      
  recordShareInvite, 
  getInviteCount     
};
