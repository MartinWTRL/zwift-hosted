const NodeCache = require('node-cache')
const axios = require('axios')

const mapLatLong = require('zwift-mobile-api/src/mapLatLong');
const { checkVisited } = require('zwift-second-screen/server/pointsOfInterest');
const Events = require('zwift-second-screen/server/events');

const poiCache = new NodeCache({ stdTTL: 30 * 60, checkPeriod: 120, useClones: false });

const playerCacheTimeout = 600 * 60;
const playerCache = new NodeCache({ stdTTL: playerCacheTimeout, checkPeriod: 120, useClones: false });

const rotations = {
  1: 90,
  2: 90,
  3: 0
}
const world_names = {
  1: 'Watopia',
  2: 'Richmond',
  3: 'London'
};

const WAYPOINTS_URL = process.env.ZwiftQuestWaypoints
    || 'http://zwiftquest.com/wp-content/uploads/2018/02/waypoints.txt';
const EVENT_NAME = 'zwiftquest';

const credit = () => ({ prompt: 'Event details at', name: 'ZwiftQuest', href: 'http://zwiftquest.com/' });

class ZwiftQuest {
  constructor(worldId) {
    this.worldId = worldId;
    this.anonRider = null;
    this.globalMessage = null;
    this.events = null;
    this.eventIsPending = false;

    this.lastPollDate = null;
  }

  initialiseRiderProvider(riderProvider) {
    if (!this.anonRider && riderProvider.loginAnonymous) {
      const result = riderProvider.loginAnonymous();
      this.anonRider = riderProvider.getAnonymous(result.cookie);
      this.anonRider.setFilter(`event:${EVENT_NAME}`);
    }

    if (riderProvider.account) {
      this.events = new Events(riderProvider.account);
    }
  }

  get() {
    const cacheId = `zwiftquest-${this.worldId}`;
    const cachedPoints = poiCache.get(cacheId);

    if (cachedPoints) {
      this.updateState(cachedPoints);
      return Promise.resolve(cachedPoints);
    } else {
      return this.getFromZwiftQuest().then(points => {
        poiCache.set(cacheId, points);
        this.updateState(points);
        return points;
      })
    }
  }

  infoPanel() {
    const scores = playerCache.keys()
        .map(key => playerCache.get(key))
        .filter(player => player.hasStarted())
        .map(player => ({
          rider: { id: player.id, firstName: player.firstName, lastName: player.lastName },
          score: player.getScore(),
          lastScore: player.lastScore
        }));
    scores.sort((a, b) => {
      const result = b.score - a.score;
      if (result === 0) {
        return a.lastScore - b.lastScore;
      }
      return result;
    });

    const messages = this.globalMessage ? {
      type: 'banner',
      list: [
        { text: this.globalMessage }
      ]
    } : null;

    return {
      details: credit(),
      scores: scores.length > 0 ? scores : null,
      showWaypoints: scores.length === 0,
      messages
    };
  }

  credit() {
    return { prompt: 'Event details at', name: 'ZwiftQuest', href: 'http://zwiftquest.com/' };
  }

  getFromZwiftQuest() {
    return this.downloadQuest().then(waypointData => {
      const quest = (waypointData.worlds && waypointData.worlds[this.worldId])
          ? waypointData.worlds[this.worldId]
          : waypointData;

      if (quest.waypoints && (!quest.worldId || this.worldId === quest.worldId)) {
        this.globalMessage = null;
        const points = [
          this.toPoint(quest.start, { image: 'zq_start', role: 'start' })
        ];
        quest.waypoints.forEach(waypoint => {
          points.push(this.toPoint(waypoint, { image: 'zq_waypoint' }));
        })

        points.push(this.toPoint(quest.finish, { image: 'zq_finish', role: 'finish' }));
        return points;
      }

      if (quest.worldId) {
        this.globalMessage = `ZwiftQuest is currently in ${world_names[quest.worldId]}`;
      } else {
        this.globalMessage = `ZwiftQuest is not currently in ${world_names[this.worldId]}`;
      }
      return [];
    })
  }

  toPoint(waypoint, props) {
    const mapDef = mapLatLong[this.worldId];
    const xy = mapDef.toXY(waypoint.lat + mapDef.offset.lat, waypoint.long + mapDef.offset.long);
    return Object.assign({
      name: waypoint.name,
      x: xy.x,
      y: xy.y,
      rotate: rotations[this.worldId],
      size: 1.8
    }, props);
  }

  downloadQuest() {
    return new Promise(resolve => {
      axios.get(WAYPOINTS_URL)
      .then(response => {
        resolve(response.data);
      }).catch(function (error) {
        console.log(error);
        resolve({});
      });
    })
  }

  updateState(points) {
    if (!this.anonRider) return;

    const currentDate = new Date();
    if (!this.lastPollDate || (currentDate - this.lastPollDate) > 2500) {
      this.checkPendingEvent();

      this.anonRider.getPositions().then(positions => {
        positions.forEach(position => {
          const cacheId = `world-${this.worldId}-player-${position.id}`;
          let player = playerCache.get(cacheId);
          if (!player) {
            player = new Player(position);
            playerCache.set(cacheId, player);
          } else {
            playerCache.ttl(cacheId, playerCacheTimeout);
          }

          player.refreshWaypoints(points);
          if (!this.eventIsPending) {
            player.updatePosition(position);
          }
        });
      });

      this.lastPollDate = currentDate;
    }
  }

  checkPendingEvent() {
    if (this.events) {
      this.events.findMatchingEvent(EVENT_NAME).then(event => {
        const timeNow = new Date();
        if (event && event.eventStart) {
          const startTime = new Date(Date.parse(event.eventStart));
          const warmupTime = new Date(startTime.getTime() - 10*60000);

          this.eventIsPending = false;
          if (warmupTime < timeNow && timeNow < startTime) {
            this.eventIsPending = true;
            this.resetScores();
          }
        } else {
          this.eventIsPending = false;
        }
      });
    }
  }

  resetScores() {
    playerCache.keys()
      .map(key => playerCache.get(key))
      .forEach(player => player.resetScore());
  }
}
ZwiftQuest.credit = credit;

class Player {
  constructor(player) {
    this.id = player.id;
    this.firstName = player.firstName;
    this.lastName = player.lastName;
    this.positions = [];
    this.waypoints = [];
    this.lastScore = new Date();
  }

  updatePosition(position) {
    if (this.positions.length === 0
        || this.positions[this.positions.length - 1].x != position.x
        || this.positions[this.positions.length - 1].y != position.y ) {
      // Check the waypoints
      this.waypoints.forEach(point => {
        if (this.waypointEnabled(point) && !point.visited) {
          const pointVisited = checkVisited(position, this.positions, point);
          if (pointVisited && pointVisited.visited) {
            point.visited = true;
            this.lastScore = pointVisited.time;
          }
        }
      });

      this.positions.push(position);
      if (this.positions.length > 3) {
        this.positions.splice(0, 1);
      }
    }
  }

  waypointEnabled(point) {
    switch(point.role) {
      case 'start':
        return true;
      case 'finish':
        return !this.waypoints.find(p => !p.role && !p.visited)
      default:
        return !this.waypoints.find(p => p.role === 'start' && !p.visited)
    }
  }

  refreshWaypoints(waypoints) {
    const existingWaypoints = this.waypoints;
    this.waypoints = waypoints.map(waypoint => {
      const existing = existingWaypoints.find(w => w.x == waypoint.x && w.y == waypoint.y && (!w.role || w.role == waypoint.role));
      return Object.assign({ visited: existing ? existing.visited : false }, waypoint);
    });
  }

  resetScore() {
    this.waypoints.forEach(w => {
      w.visited = false;
    });
  }

  hasStarted() {
    return !!this.waypoints.find(w => w.visited);
  }

  getScore() {
    return this.waypoints.reduce((score, waypoint) => {
      return score + ((waypoint.role !== 'start' && waypoint.visited) ? 1 : 0);
    }, 0);
  }
}

const distance = (p1, p2) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

module.exports = ZwiftQuest;
