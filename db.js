const { Sequelize, DataTypes, Op } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql",
  logging: false,
});

// 定义数据模型
const Counter = sequelize.define("Counter", {
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

// ============ 游戏存档模型 ============
const GameSave = sequelize.define("GameSave", {
  openid: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
    unique: true,
  },
  gameData: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '{}',
  },
});

// ============ 分享邀请记录模型 ============
const ShareInvite = sequelize.define("ShareInvite", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  inviterOpenId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  inviteeOpenId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'completed',
  },
  extraInfo: {
    type: DataTypes.TEXT,
    allowNull: true,
  }
}, {
  indexes: [
    {
      fields: ['inviterOpenId']
    },
    {
      fields: ['createdAt']
    }
  ]
});

// ============ 每日排行榜模型 ============
const DailyRank = sequelize.define("DailyRank", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  playerName: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  roleID: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  instanceID: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  openid: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  recordDate: {
    type: DataTypes.STRING(10),
    allowNull: false,
    comment: '北京日期 (YYYY-MM-DD)'
  }
  // 注意：不在这里定义 createdAt，让 Sequelize 自动管理
}, {
  timestamps: true, // 启用 createdAt 和 updatedAt
  createdAt: 'createdAt', // 明确指定字段名
  updatedAt: false, // 不启用 updatedAt
  
  indexes: [
    {
      name: 'idx_date_score',
      fields: ['recordDate', { name: 'instanceID', order: 'DESC' }]
    },
    {
      name: 'idx_user_date',
      fields: ['openid', 'recordDate'],
      unique: true
    },
    {
      name: 'idx_date_created',
      fields: ['recordDate', 'instanceID', 'createdAt']
    }
  ],
  comment: '每日排行榜，只保留前100名'
});

// 数据库初始化方法
async function init() {
  try {
    await Counter.sync({ alter: true });
    console.log('Counter 表同步成功');
    
    await GameSave.sync({ alter: true }); 
    console.log('GameSave 表同步成功');

    await ShareInvite.sync({ alter: true });
    console.log('ShareInvite 表同步成功');

    await DailyRank.sync({ alter: true });
    console.log('DailyRank 表同步成功');
    
  } catch (error) {
    console.error('数据库表同步失败:');
    console.error('错误名称:', error.name);
    console.error('错误信息:', error.message);
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
      status: 'completed'
    }
  });
}

/**
 * 修剪今日排行榜，只保留前100名
 */
async function trimTodayRank(today) {
  try {
    // 先查询需要保留的记录
    const recordsToKeep = await DailyRank.findAll({
      where: { recordDate: today },
      order: [
        ['instanceID', 'DESC'],
        ['createdAt', 'ASC']
      ],
      limit: 100
    });
    
    if (recordsToKeep.length === 0) {
      return 0;
    }
    
    // 获取需要保留的记录ID
    const idsToKeep = recordsToKeep.map(record => record.id);
    
    // 删除不在保留列表中的记录
    const result = await DailyRank.destroy({
      where: {
        recordDate: today,
        id: { [Op.notIn]: idsToKeep }
      }
    });
    
    console.log(`[${today}] 排行榜已修剪，保留了前100名，删除了 ${result} 条记录`);
    return result;
  } catch (error) {
    console.error('修剪排行榜失败:', error);
    return 0;
  }
}

/**
 * 获取北京时间日期字符串
 */
function getBeijingDateString(date = new Date()) {
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.toISOString().split('T')[0];
}

// 导出初始化方法和模型
module.exports = {
  init,
  sequelize,
  Op,
  Counter,
  GameSave,
  ShareInvite,
  DailyRank,      
  recordShareInvite, 
  getInviteCount,
  trimTodayRank,
  getBeijingDateString
};