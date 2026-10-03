'use strict';

const TABLE_ROOM = 'dragontiger:table';

function userRoom(userId) {
  return `dragontiger:user:${Number(userId)}`;
}

module.exports = {
  TABLE_ROOM,
  userRoom,
};
