import _ from "lodash";
import Promise from "bluebird";
import moment from "moment";

/**
 * Superset of Intercom API
 */
export default class IntercomAgent {

  constructor(intercomClient, queueAgent, ship, hullClient) {
    this.intercomClient = intercomClient;
    this.queueAgent = queueAgent;
    this.ship = ship;
    this.hullClient = hullClient;
  }

  getJob(id) {
    return this.intercomClient.get(`/jobs/${id}`)
      .then(res => {
        const isCompleted = _.get(res, "body.tasks[0].state") === "completed"
          || _.get(res, "body.tasks[0].state") === "completed_with_errors";

        const hasErrors = _.get(res, "body.tasks[0].state") === "completed_with_errors";

        return {
          isCompleted,
          hasErrors
        };
      });
  }

  getJobErrors(id) {
    return this.intercomClient.get(`/jobs/${id}/error`)
      .then(res => {
        return _.get(res, "body.items", []);
      });
  }

  importUsers(scroll_param = null) {
    return this.intercomClient.get("/users/scroll")
    .query({ scroll_param })
    .then(response => {
      const { users, scroll_param: next_scroll_param } = response.body;

      return { users, scroll_param: next_scroll_param };
    })
    .catch(err => {
      const fErr = this.intercomClient.handleError(err);

      if (_.get(fErr, "extra.body.errors[0].code") === "scroll_exists") {
        this.hullClient.logger.error("Trying to perform two separate scrolls");
        return Promise.resolve([]);
      }

      if (_.get(fErr, "extra.body.errors[0].code") === "not_found") {
        this.hullClient.logger.error("Scroll expired, should start it again");
        return Promise.resolve([]);
      }

      // handle errors which may happen here
      return Promise.reject(fErr);
    });
  }

  saveUsers(users, mode = "bulk") {
    if (_.isEmpty(users)) {
      return Promise.resolve();
    }

    this.hullClient.logger.info("SAVING", users.length);

    const body = {
      items: users.map(u => {
        return {
          method: "post",
          data_type: "user",
          data: u
        };
      })
    };

    if (users.length < (process.env.MINMUM_BULK_SIZE || 10)
      || mode === "regular") {

      return Promise.map(body.items, item => {
        return this.intercomClient.post("/users")
          .send(item.data)
          .then(response => {
            return response.body;
          })
          .catch(err => {
            const fErr = this.intercomClient.handleError(err);
            this.hullClient.logger.error("intercomAgent.saveUsers.microbatch.error", fErr);
            return Promise.resolve(fErr);
          });
      }, { concurrency: 5 });
    }

    return this.intercomClient
      .post("/bulk/users")
      .send(body)
      .catch(err => {
        const fErr = this.intercomClient.handleError(err);
        thus.hullClient.logger.error("intercomAgent.saveUsers.bulkSubmit.error", fErr);
        return Promise.reject(fErr);
      });
  }

  tagUsers(ops) {
    const opArray = [];
    _.map(ops, (op, segmentName) => {
      opArray.push({
        name: segmentName,
        users: op
      });
    });
    return Promise.map(opArray, (op) => {
      return this.intercomClient.post("/tags")
        .send(op)
        .catch(err => {
          const fErr = this.intercomClient.handleError(err);
          this.hullClient.logger.error("intercomAgent.tagUsers.error", fErr);
          return Promise.reject(fErr);
        });
    }, { concurrency: 3 });
  }

  /**
   * get total count of users
   */
  getUsersTotalCount() {
    return this.intercomClient.get("/users")
      .query({ per_page: 1 })
      .then(response => {
        return _.get(response, "body.total_count");
      })
      .catch(err => {
        const fErr = this.intercomClient.handleError(err);
        this.hullClient.logger.error("getUsersTotalCount.error", fErr);
        return Promise.reject(fErr);
      });
  }

  getRecentUsers(last_updated_at, count, page) {
    return this.intercomClient.get("/users")
      .query({
        per_page: count,
        page,
        order: "desc",
        sort: "updated_at"
      })
      .then(response => {
        const originalUsers = _.get(response, "body.users", []);
        const users = originalUsers.filter((u) => {
          return moment(u.updated_at, "X")
            .isAfter(last_updated_at);
        });
        this.hullClient.logger.info("getRecentUsers.count", {
          total: originalUsers.length,
          filtered: users.length
        });

        return {
          users,
          hasMore: !_.isEmpty(_.get(response, "body.pages.next"))
            && users.length === originalUsers.length
        };
      })
      .catch(err => {
        const fErr = this.intercomClient.handleError(err);
        this.hullClient.logger.error("getRecentUsers.error", fErr);
        return Promise.reject(fErr);
      });
  }

}
