import _ from "lodash";
import moment from "moment";

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

  saveUserError(error) {
    const email = _.get(error, "req.data.email");
    const errorMessage = _.get(error, "body.errors", []).map(e => e.message).join(" ");

    return this.hullAgent.hullClient.as({ email }).traits({
      "intercom/import_error": errorMessage
    });
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
          user.segment_ids.map(segment_id => {
            const segment = _.find(segments, { id: segment_id });
            if (_.isEmpty(segment)) {
              this.hullClient.logger.error("segment not found", segment);
              return o;
            }
            o[segment.name] = o[segment.name] || [];
            o[segment.name].push({
              email: user.email
            });
          });
          user.remove_segment_ids.map(segment_id => {
            const segment = _.find(segments, { id: segment_id });
            if (_.isEmpty(segment)) {
              this.hullClient.logger.error("segment not found", segment);
              return o;
            }
            o[segment.name] = o[segment.name] || [];
            o[segment.name].push({
              email: user.email,
              untag: true
            });
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
