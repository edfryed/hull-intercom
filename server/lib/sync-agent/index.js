import _ from "lodash";
import moment from "moment";
import Promise from "bluebird";

import TagMapping from "./tag-mapping";
import UserMapping from "./user-mapping";
import WebhookAgent from "./webhook-agent";

export default class SyncAgent {

  constructor(intercomAgent, hullAgent, ship, hostname, hullClient) {
    this.ship = ship;
    this.hullAgent = hullAgent;
    this.intercomAgent = intercomAgent;
    this.hullClient = hullClient;

    this.tagMapping = new TagMapping(intercomAgent, hullAgent, ship);
    this.userMapping = new UserMapping(ship);
    this.webhookAgent = new WebhookAgent(intercomAgent, hullAgent, ship, hostname);
  }

  isConfigured() {
    return this.intercomAgent.intercomClient.ifConfigured();
  }

  syncShip() {
    return this.webhookAgent.ensureWebhook()
      .then(() => this.hullAgent.getSegments())
      .then((segments) => this.tagMapping.sync(segments));
  }

  /**
   *
   */
  userAdded(user) {
    return !_.isEmpty(user["traits_intercom/id"]);
  }

  /**
   *
   */
  userWithError(user) {
    return !_.isEmpty(user["traits_intercom/import_error"]);
  }

  /**
   * error {Array} [{
   *  data: {
   *    email: "email"
   *  },
   *  error: [
   *    message: "message"
   *  ]
   * }]
   */
  handleUserErrors(errors, users) {
    return Promise.map(errors, error => {
      const email = _.get(error, "data.email");
      const errorDetails = _.get(error, "error", []);
      const errorMessage = errorDetails.map(e => e.message).join(" ");
      if (_.find(errorDetails, { code: "conflict"})) {
        return _.find(users, { email });
      }

      return this.hullAgent.hullClient.as({ email }).traits({
        "intercom/import_error": errorMessage
      })
      .then(() => false);
    }).then(res => _.filter(res));
  }

  getUsersToSave(users) {
    return users.filter((u) => this.hullAgent.userComplete(u)
      && this.hullAgent.userWhitelisted(u)
      && !this.userWithError(u));
  }

  getUsersToTag(users) {
    return users.filter((u) => this.hullAgent.userWhitelisted(u)
      && this.userAdded(u)
      && !this.userWithError(u));
  }

  groupUsersToTag(users) {
    return this.hullAgent.getSegments()
      .then(segments => {
        const ops = _.reduce(users, (o, user) => {
          let userOp = {};
          if (!_.isEmpty(user["traits_intercom/id"])) {
            userOp.id = user["traits_intercom/id"];
          } else if(!_.isEmpty(user.email)) {
            userOp.email = user.email;
          } else {
            return o;
          }
          user.segment_ids.map(segment_id => {
            const segment = _.find(segments, { id: segment_id });
            if (_.isEmpty(segment)) {
              this.hullClient.logger.error("segment not found", segment);
              return o;
            }
            o[segment.name] = o[segment.name] || [];
            o[segment.name].push(userOp);
          });
          user.remove_segment_ids.map(segment_id => {
            const segment = _.find(segments, { id: segment_id });
            if (_.isEmpty(segment)) {
              this.hullClient.logger.error("segment not found", segment);
              return o;
            }
            o[segment.name] = o[segment.name] || [];
            o[segment.name].push(_.merge({}, userOp, {
              untag: true
            }));
          });
          return o;
        }, {});
        return ops;
      });
  }

  /**
   * When the user is within the
   * @type {Array}
   */
  updateUserSegments(user, { add_segment_ids = [], remove_segment_ids = [] }) {
    if (this.hullAgent.userWhitelisted(user)) {
      user.segment_ids = _.uniq(_.concat(user.segment_ids || [], _.filter(add_segment_ids)));
      user.remove_segment_ids = _.filter(remove_segment_ids);
    } else {
      if (this.userAdded(user)) {
        user.segment_ids = [];
        user.remove_segment_ids = this.tagMapping.getSegmentIds();
      } else {
        return null;
      }
    }
    return user;
  }

  /**
   * Get information about last import done from intercom
   * @return {Promise}
   */
  getLastUpdatedAt() {
    return this.hullAgent.hullClient.get("/search/user_reports", {
      include: ["traits_intercom/updated_at"],
      sort: {
        "traits_intercom/updated_at": "desc"
      },
      per_page: 1,
      page: 1
    })
    .then((r) => {
      return r.data[0]["traits_intercom/updated_at"];
    })
    .catch(() => {
      return Promise.resolve(moment().utc().format());
    });
  }

}
