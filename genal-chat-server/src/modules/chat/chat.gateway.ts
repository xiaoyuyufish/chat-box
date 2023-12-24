import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, getRepository } from 'typeorm';
import { User } from '../user/entity/user.entity';
import { Group, GroupMap } from '../group/entity/group.entity';
import { GroupMessage } from '../group/entity/groupMessage.entity';
import { UserMap } from '../friend/entity/friend.entity';
import { FriendMessage } from '../friend/entity/friendMessage.entity';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { RCode } from 'src/common/constant/rcode';
import { nameVerify } from 'src/common/tool/utils';

@WebSocketGateway()
export class ChatGateway {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(GroupMap)
    private readonly groupUserRepository: Repository<GroupMap>,
    @InjectRepository(GroupMessage)
    private readonly groupMessageRepository: Repository<GroupMessage>,
    @InjectRepository(UserMap)
    private readonly friendRepository: Repository<UserMap>,
    @InjectRepository(FriendMessage)
    private readonly friendMessageRepository: Repository<FriendMessage>,
  ) {
    this.defaultGroup = '聊天室';
  }

  @WebSocketServer()
  server: Server;

  // 默认群
  defaultGroup: string;

  // socket连接钩子
  async handleConnection(client: Socket): Promise<string> {
    const userRoom = client.handshake.query.userId;
    // 连接默认加入"聊天室"房间
    client.join(this.defaultGroup);
    // 进来统计在线人数
    this.getActiveGroupUser();
    // 用户独有消息房间 根据userId
    if(userRoom) {
      client.join(userRoom);
    }
    return '连接成功';
  }

  // socket断连钩子
  async handleDisconnect():Promise<any> {
    this.getActiveGroupUser();
  }

// 订阅WebSocket消息事件'addGroup'，用于创建群组
  @SubscribeMessage('addGroup')
  async addGroup(@ConnectedSocket() client: Socket, @MessageBody() data: Group): Promise<any> {
    // 检查请求创建群组的用户是否存在
    const isUser = await this.userRepository.findOne({userId: data.userId});

    // 如果用户存在，则进行下一步
    if(isUser) {
      // 检查群组名是否已经被使用
      const isHaveGroup = await this.groupRepository.findOne({ groupName: data.groupName });

      // 如果群组名已存在，给客户端发送群组已存在的消息
      if (isHaveGroup) {
        this.server.to(data.userId).emit('addGroup', { code: RCode.FAIL, msg: '该群名字已存在', data: isHaveGroup });
        return;
      }

      // 如果群组名不符合验证条件（具体验证逻辑不在代码段中提供），则不执行后续操作
      if(!nameVerify(data.groupName)) {
        return;
      }

      // 保存群组信息到数据库
      data = await this.groupRepository.save(data);

      // 将创建群组的客户端加入到新创建的群组中
      client.join(data.groupId);

      // 保存群组用户关系到数据库
      const group = await this.groupUserRepository.save(data);

      // 向客户端发送成功创建群组的消息
      this.server.to(group.groupId).emit('addGroup', { code: RCode.OK, msg: `成功创建群${data.groupName}`, data: group });

      // 更新群组中的活跃用户信息
      this.getActiveGroupUser();
    } else {
      // 如果用户不存在，给客户端发送没有创建群组资格的消息
      this.server.to(data.userId).emit('addGroup', { code: RCode.FAIL, msg: `你没资格创建群` });
    }
  }


  // 订阅WebSocket消息事件'joinGroup'，用于用户加入群组
  @SubscribeMessage('joinGroup')
  async joinGroup(@ConnectedSocket() client: Socket, @MessageBody() data: GroupMap): Promise<any> {
    // 首先确认请求加入群组的用户是否存在
    const isUser = await this.userRepository.findOne({ userId: data.userId });

    // 如果用户存在
    if(isUser) {
      // 然后确认请求加入的群组是否存在
      const group = await this.groupRepository.findOne({ groupId: data.groupId });

      // 查询用户和群组的关联信息
      let userGroup = await this.groupUserRepository.findOne({ groupId: group.groupId, userId: data.userId });

      // 重新获取一次用户信息（可能用于获取最新的用户状态或其他信息）
      const user = await this.userRepository.findOne({ userId: data.userId });

      // 如果群组和用户都有效
      if (group && user) {
        // 如果用户尚未加入该群组
        if (!userGroup) {
          // 设置关联的群组ID
          data.groupId = group.groupId;
          // 在数据库中保存用户和群组的关系
          userGroup = await this.groupUserRepository.save(data);
        }

        // 将用户的客户端加入到该群组的Socket.IO房间中
        client.join(group.groupId);

        // 准备返回的响应数据
        const res = { group: group, user: user };

        // 向群组中的所有成员广播某用户加入群组的消息
        this.server.to(group.groupId).emit('joinGroup', {
          code: RCode.OK,
          msg: `${user.username}加入群${group.groupName}`,
          data: res
        });

        // 更新群组中的活跃用户信息
        this.getActiveGroupUser();
      } else {
        // 如果用户或群组无效，则向请求的用户发送加入群组失败的消息
        this.server.to(data.userId).emit('joinGroup', { code: RCode.FAIL, msg: '进群失败', data: '' });
      }
    } else {
      // 如果用户不存在，则发送没有资格加入群组的消息
      this.server.to(data.userId).emit('joinGroup', { code: RCode.FAIL, msg: '你没资格进群'});
    }
  }


// 订阅WebSocket消息事件'groupMessage'，用于处理发送到群组的消息
  @SubscribeMessage('groupMessage')
  async sendGroupMessage(@MessageBody() data: GroupMessageDto): Promise<any> {
    // 验证发送消息的用户是否存在
    const isUser = await this.userRepository.findOne({userId: data.userId});

    // 如果用户存在
    if(isUser) {
      // 验证用户是否属于该群组
      const userGroupMap = await this.groupUserRepository.
      findOne({userId: data.userId, groupId: data.groupId});

      // 如果用户不属于该群组或未提供群组ID，向用户发送错误消息
      if(!userGroupMap || !data.groupId) {
        this.server.to(data.userId).
        emit('groupMessage', {code: RCode.FAIL, msg: '群消息发送错误', data: ''});
        return; // 结束函数执行
      }

      // 如果消息类型为图片
      if(data.messageType === 'image') {
        // 创建一个随机文件名
        const randomName = `${Date.now()}$${data.userId}$${data.width}$${data.height}`;
        // 创建文件写入流并保存图片到指定的'static'目录
        const stream = createWriteStream(join('public/static', randomName));
        stream.write(data.content); // 写入图片数据
        data.content = randomName; // 更新消息内容为图片的文件名
      }

      // 设置消息的发送时间为当前服务器时间
      data.time = new Date().valueOf();

      // 将消息保存到群消息记录中
      await this.groupMessageRepository.save(data);

      // 向整个群组广播消息
      this.server.to(data.groupId).emit('groupMessage',
          {code: RCode.OK, msg: '', data: data});
    } else {
      // 如果用户不存在，向用户发送没有发送消息权限的错误消息
      this.server.to(data.userId).emit('groupMessage',
          {code: RCode.FAIL, msg: '你没资格发消息' });
    }
  }


  // 订阅WebSocket消息事件'addFriend'，用于添加好友
  @SubscribeMessage('addFriend')
  async addFriend(@ConnectedSocket() client: Socket, @MessageBody() data: UserMap): Promise<any> {
    // 验证请求添加好友的用户是否存在
    const isUser = await this.userRepository.findOne({userId: data.userId});

    // 如果用户存在
    if(isUser) {
      // 检查是否提供了有效的好友ID和用户ID，以及用户不能添加自己为好友
      if (data.friendId && data.userId && data.userId !== data.friendId) {
        // 检查这两个用户之间是否已经存在好友关系
        const relation1 = await this.friendRepository.findOne({ userId: data.userId,
          friendId: data.friendId });
        const relation2 = await this.friendRepository.findOne({ userId: data.friendId,
          friendId: data.userId });
        // 创建一个由两个用户ID组成的房间ID
        const roomId = data.userId > data.friendId ?
            data.userId + data.friendId : data.friendId + data.userId;

        // 如果已经存在好友关系，则发送失败消息
        if (relation1 || relation2) {
          this.server.to(data.userId).emit('addFriend',
              { code: RCode.FAIL, msg: '已经有该好友', data: data });
          return;
        }

        // 检查待添加的好友是否存在
        const friend = await this.userRepository.findOne({userId: data.friendId});
        const user = await this.userRepository.findOne({userId: data.userId});

        // 如果该好友不存在，发送失败消息
        if (!friend) {
          this.server.to(data.userId).emit('addFriend',
              { code: RCode.FAIL, msg: '该好友不存在', data: '' });
          return;
        }

        // 在数据库中保存两个用户之间的好友关系
        await this.friendRepository.save(data);
        // 创建反向关系并保存
        const friendData = JSON.parse(JSON.stringify(data));
        const friendId = friendData.friendId;
        friendData.friendId = friendData.userId;
        friendData.userId = friendId;
        delete friendData._id; // 删除不需要的_id字段
        await this.friendRepository.save(friendData);

        // 让用户加入一个共有的房间，可能用于私聊
        client.join(roomId);

        // 获取最近的私聊消息记录
        let messages = await getRepository(FriendMessage)
            .createQueryBuilder("friendMessage")
            .orderBy("friendMessage.time", "DESC")
            .where("friendMessage.userId = :userId AND friendMessage.friendId = :friendId", { userId: data.userId, friendId: data.friendId })
            .orWhere("friendMessage.userId = :friendId AND friendMessage.friendId = :userId", { userId: data.userId, friendId: data.friendId })
            .take(30)
            .getMany();
        messages = messages.reverse(); // 将消息顺序反转，以得到正确的时间顺序

        // 如果有消息记录，将消息记录添加到用户信息中
        if(messages.length) {
          // @ts-ignore
          friend.messages = messages;
          // @ts-ignore
          user.messages = messages;
        }

        // 向请求添加好友的用户发送成功消息
        this.server.to(data.userId).emit('addFriend',
            { code: RCode.OK, msg: `添加好友${friend.username}成功`, data: friend });
        // 同时向被添加的好友发送通知消息
        this.server.to(data.friendId).emit('addFriend',
            { code: RCode.OK, msg: `${user.username}添加你为好友`, data: user });
      } else {
        // 如果提供的好友ID无效或试图添加自己为好友，发送失败消息
        this.server.to(data.userId).emit('addFriend',
            { code: RCode.FAIL, msg: '不能添加自己为好友', data: '' });
      }
    } else {
      // 如果用户不存在，发送没有添加好友权限的失败消息
      this.server.to(data.userId).emit('addFriend',
          {code: RCode.FAIL, msg:'你没资格加好友' });
    }
  }


  // 加入私聊的socket连接
  @SubscribeMessage('joinFriendSocket')
  async joinFriend(@ConnectedSocket() client: Socket, @MessageBody() data: UserMap):Promise<any> {
    if(data.friendId && data.userId) {
      const relation = await this.friendRepository.findOne({ userId: data.userId, friendId: data.friendId });
      const roomId = data.userId > data.friendId ?  data.userId + data.friendId : data.friendId + data.userId;
      if(relation) {
        client.join(roomId);
        this.server.to(data.userId).emit('joinFriendSocket',{ code:RCode.OK, msg:'进入私聊socket成功', data: relation });
      } 
    }
  }

// 订阅WebSocket消息事件'friendMessage'，用于发送私聊消息
  @SubscribeMessage('friendMessage')
  async friendMessage(@ConnectedSocket() client: Socket, @MessageBody() data: FriendMessageDto): Promise<any> {
    // 检查发送消息的用户是否存在
    const isUser = await this.userRepository.findOne({userId: data.userId});

    // 如果用户存在
    if(isUser) {
      // 确保传入了有效的用户ID和好友ID
      if(data.userId && data.friendId) {
        // 根据用户ID生成房间ID，用于私聊
        const roomId = data.userId > data.friendId ? data.userId + data.friendId : data.friendId + data.userId;

        // 如果消息类型为图片
        if(data.messageType === 'image') {
          // 生成一个随机文件名，包括当前时间戳、房间ID和图片尺寸
          const randomName = `${Date.now()}$${roomId}$${data.width}$${data.height}`;
          // 创建文件写入流，保存图片到服务器上的'static'目录
          const stream = createWriteStream(join('public/static', randomName));
          stream.write(data.content); // 写入图片数据
          data.content = randomName; // 更新消息内容为图片文件名
        }

        // 设置消息的时间戳
        data.time = new Date().valueOf();

        // 保存消息到数据库
        await this.friendMessageRepository.save(data);

        // 向房间里的所有成员广播私聊消息
        this.server.to(roomId).emit('friendMessage', {code: RCode.OK, msg:'', data});
      }
    } else {
      // 如果用户不存在，向尝试发送消息的用户发送错误消息
      this.server.to(data.userId).emit('friendMessage', {code: RCode.FAIL, msg:'你没资格发消息', data});
    }
  }


  // 获取所有群和好友数据
  @SubscribeMessage('chatData') 
  async getAllData(@ConnectedSocket() client: Socket,  @MessageBody() user: User):Promise<any> {
    const isUser = await this.userRepository.findOne({userId: user.userId, password: user.password});
    if(isUser) {
      let groupArr: GroupDto[] = [];
      let friendArr: FriendDto[] = [];
      const userGather: {[key: string]: User} = {};
      let userArr: FriendDto[] = [];
    
      const groupMap: GroupMap[] = await this.groupUserRepository.find({userId: user.userId}); 
      const friendMap: UserMap[] = await this.friendRepository.find({userId: user.userId});

      const groupPromise = groupMap.map(async (item) => {
        return await this.groupRepository.findOne({groupId: item.groupId});
      });
      const groupMessagePromise = groupMap.map(async (item) => {
        let groupMessage = await getRepository(GroupMessage)
        .createQueryBuilder("groupMessage")
        .orderBy("groupMessage.time", "DESC")
        .where("groupMessage.groupId = :id", { id: item.groupId })
        .take(30)
        .getMany();
        groupMessage = groupMessage.reverse();
        // 这里获取一下发消息的用户的用户信息
        for(const message of groupMessage) {
          if(!userGather[message.userId]) {
            userGather[message.userId] = await this.userRepository.findOne({userId: message.userId});
          }
        }
        return groupMessage;
      });

      const friendPromise = friendMap.map(async (item) => {
        return await this.userRepository.findOne({
          where:{userId: item.friendId}
        });
      });
      const friendMessagePromise = friendMap.map(async (item) => {
        const messages = await getRepository(FriendMessage)
          .createQueryBuilder("friendMessage")
          .orderBy("friendMessage.time", "DESC")
          .where("friendMessage.userId = :userId AND friendMessage.friendId = :friendId", { userId: item.userId, friendId: item.friendId })
          .orWhere("friendMessage.userId = :friendId AND friendMessage.friendId = :userId", { userId: item.userId, friendId: item.friendId })
          .take(30)
          .getMany();
        return messages.reverse();
      });

      const groups: GroupDto[]  = await Promise.all(groupPromise);
      const groupsMessage: Array<GroupMessageDto[]> = await Promise.all(groupMessagePromise);
      groups.map((group,index)=>{
        if(groupsMessage[index] && groupsMessage[index].length) {
          group.messages = groupsMessage[index];
        }
      });
      groupArr = groups;

      const friends: FriendDto[] = await Promise.all(friendPromise);
      const friendsMessage: Array<FriendMessageDto[]> = await Promise.all(friendMessagePromise);
      friends.map((friend, index) => {
        if(friendsMessage[index] && friendsMessage[index].length) {
          friend.messages = friendsMessage[index];
        }
      });
      friendArr = friends;
      userArr = [...Object.values(userGather), ...friendArr];

      this.server.to(user.userId).emit('chatData', {code:RCode.OK,
        msg: '获取聊天数据成功', data: {
        groupData: groupArr,
        friendData: friendArr,
        userData: userArr
      }});
    }
  }

  // 退群
  @SubscribeMessage('exitGroup') 
  async exitGroup(@ConnectedSocket() client: Socket,  @MessageBody() groupMap: GroupMap):Promise<any> {
    if(groupMap.groupId === this.defaultGroup) {
      return this.server.to(groupMap.userId).emit('exitGroup',{code: RCode.FAIL, msg: '默认群不可退'});
    }
    const user = await this.userRepository.findOne({userId: groupMap.userId});
    const group = await this.groupRepository.findOne({groupId: groupMap.groupId});
    const map = await this.groupUserRepository.findOne({userId: groupMap.userId, groupId: groupMap.groupId});
    if(user && group && map) {
      await this.groupUserRepository.remove(map);
      this.server.to(groupMap.userId).emit('exitGroup',{code: RCode.OK, msg: '退群成功', data: groupMap});
      return this.getActiveGroupUser();
    }
    this.server.to(groupMap.userId).emit('exitGroup',{code: RCode.FAIL, msg: '退群失败'});
  }

  // 删好友
  @SubscribeMessage('exitFriend') 
  async exitFriend(@ConnectedSocket() client: Socket,  @MessageBody() userMap: UserMap):Promise<any> {
    const user = await this.userRepository.findOne({userId: userMap.userId});
    const friend = await this.userRepository.findOne({userId: userMap.friendId});
    const map1 = await this.friendRepository.findOne({userId: userMap.userId, friendId: userMap.friendId});
    const map2 = await this.friendRepository.findOne({userId: userMap.friendId, friendId: userMap.userId});
    if(user && friend && map1 && map2) {
      await this.friendRepository.remove(map1);
      await this.friendRepository.remove(map2);
      return this.server.to(userMap.userId).emit('exitFriend',{code: RCode.OK, msg: '删好友成功', data: userMap});
    }
    this.server.to(userMap.userId).emit('exitFriend',{code: RCode.FAIL, msg: '删好友失败'});
  }

  // 获取在线用户
  async getActiveGroupUser() {
    // 从socket中找到连接人数
    // @ts-ignore;
    let userIdArr = Object.values(this.server.engine.clients).map(item=>{
      // @ts-ignore;
      return item.request._query.userId;
    });
    // 数组去重
    userIdArr = Array.from(new Set(userIdArr));

    const activeGroupUserGather = {};
    for(const userId of userIdArr) {
      const userGroupArr = await this.groupUserRepository.find({userId: userId});
      const user = await this.userRepository.findOne({userId: userId});
      if(user && userGroupArr.length) {
        userGroupArr.map(item => {
          if(!activeGroupUserGather[item.groupId]) {
            activeGroupUserGather[item.groupId] = {};
          }
          activeGroupUserGather[item.groupId][userId] = user;
        });
      }
    }

    this.server.to(this.defaultGroup).emit('activeGroupUser',{
      msg: 'activeGroupUser', 
      data: activeGroupUserGather
    });
  }
}
