'use strict';

var Promise = require('promise');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:aws-manager');
// XXX var objFilter = require('../lib/objFilter');
var shuffle = require('knuth-shuffle');
var taskcluster = require('taskcluster-client');
var series = require('./influx-series');

const MAX_ITERATIONS_FOR_STATE_RESOLUTION = 20;

function dateForInflux (thingy) {
  if (typeof thingy === 'object' && thingy.getTime) {
    // assume this is a date object
    return thingy.getTime();
  } else if (typeof thingy === 'string') {
    return new Date(thingy).getTime();
  }
  throw new Error('dont know how to thing this thingy');
}

/**
 * AWS EC2 state at a specific moment in time
 */
function AwsManager (ec2, provisionerId, keyPrefix, pubKey, maxInstanceLife, influx) {
  assert(ec2);
  assert(provisionerId);
  assert(keyPrefix);
  assert(pubKey);
  assert(maxInstanceLife);
  assert(influx);
  this.ec2 = ec2;
  this.provisionerId = provisionerId;
  this.keyPrefix = keyPrefix;
  this.pubKey = pubKey;
  this.maxInstanceLife = maxInstanceLife;
  this.influx = influx;
  this.__knownKeyPairs = [];
  this.__apiState = {
    instances: [],
    requests: [],
  };
  this.__previousApiState = this.__apiState;
  this.__internalState = [];

  // This is used to store the list of instances we're awaiting state change
  // reasons for
  this.__awaitingStateReason = [];

  // This is used to store the spot requests which are pending their state
  // changing to fulfilled
  this.__awaitingSpotFulfilmentStatus = [];

  // Set up reporters
  this.reportEc2ApiLag = series.ec2ApiLag.reporter(influx);
  this.reportSpotRequestsSubmitted = series.spotRequestsSubmitted.reporter(influx);
  this.reportSpotRequestsFulfilled = series.spotRequestsFulfilled.reporter(influx);
  this.reportSpotRequestsDied = series.spotRequestsDied.reporter(influx);
  this.reportInstanceTerminated = series.instanceTerminated.reporter(influx);
  this.reportSpotPriceFloorFound = series.spotPriceFloorFound.reporter(influx);
  this.reportAmiUsage = series.amiUsage.reporter(influx);
}

module.exports = AwsManager;

/**
 * Update the state from the AWS API and return a promise
 * with no resolution value when completed.
 */
AwsManager.prototype.update = function () {
  var that = this;

  // We fetch the living instance and spot requests separate from the dead ones
  // to make things a little easier to work with as there's really very little
  // in the provisioner which requires info on dead instances and spot requests
  //
  // The choice in which bucket each instance or request should belong in comes
  // down to whether or not the resource is awaiting or currently working or
  // needs to be tidied up after
  var p = Promise.all([
    that.ec2.describeInstances({
      Filters: [
        {
          Name: 'key-name',
          Values: [that.keyPrefix + '*'],
        },
        {
          Name: 'instance-state-name',
          Values: ['running', 'pending'],
        },
      ],
    }),
    that.ec2.describeSpotInstanceRequests({
      Filters: [
        {
          Name: 'launch.key-name',
          Values: [that.keyPrefix + '*'],
        }, {
          Name: 'state',
          Values: ['open'],
        },
      ],
    }),
    that.ec2.describeInstances({
      Filters: [
        {
          Name: 'key-name',
          Values: [that.keyPrefix + '*'],
        },
        {
          Name: 'instance-state-name',
          Values: ['shutting-down', 'terminated', 'stopping'],
        },
      ],
    }),
    that.ec2.describeSpotInstanceRequests({
      Filters: [
        {
          Name: 'launch.key-name',
          Values: [that.keyPrefix + '*'],
        }, {
          Name: 'state',
          Values: ['cancelled', 'failed', 'closed', 'active'],
        },
      ],
    }),
  ]);

  p = p.then(function (res) {
    var livingInstances = res[0];
    var livingSpotRequests = res[1];
    var deadInstances = res[2];
    var deadSpotRequests = {};

    // NOTE: Dead spot request does not mean that the spot request failed,
    //       just that it's no longer an open spot request...

    // TODO: Probably better to do a single set of describe calls and bucket
    //       them in this section... hmm, no strong feelings until data

    // Because we don't filter the spot requests, we'll need to make sure that
    // we remove the SpotInstanceRequests per-region response so that
    // that._classify() knows how to interpret the data
    Object.keys(res[3]).forEach(function (region) {
      deadSpotRequests[region] = res[3][region].SpotInstanceRequests;
    });

    // We don't currently handle this case because it seems to be deprecated in
    // the docs.  We should be alerted if it begins to be used again
    if (livingInstances.NextToken && livingInstances.NextToken !== '') {
      console.log('[alert-operator] WARNING!  We have a ' +
          'DescribeInstances NextToken and arent using it!!!');
    }
    var filteredSpotRequests = that._filterSpotRequests(livingSpotRequests);

    // We store the last iteration's state
    that.__previousApiState = that.__apiState;
    that.__apiState = that._classify(livingInstances, filteredSpotRequests.good);
    that.__deadState = that._classify(deadInstances, deadSpotRequests);

    // remove this try/catch once this has been live for a while
    try {
      var stateDifferences = that._compareStates(that.__apiState, that.__previousApiState, that.__deadState);
      that._reconcileStateDifferences(stateDifferences, that.__deadState, that.__apiState);
    } catch(err) {
      console.log('[alert-operator] failure in computing differences');
      console.log(err);
      if (err.stack) {
        console.log(err.stack);
      }
    }

    return that.handleStalledRequests(filteredSpotRequests.stalled);
  });

  p = p.then(function () {
    // We want to make sure that our internal state is always up to date when
    // we fetch the updated state
    that._reconcileInternalState();
  });

  return p;
};

/**
 * Handle SpotRequests that we consider to have stalled.  For now, this means
 * just cancel them.  In future this will do nifty things like maintaining
 * state about which type/region/zone combinations are not working well right
 * now
 */
AwsManager.prototype.handleStalledRequests = function (spotReqs) {
  var that = this;
  return Promise.all(Object.keys(spotReqs).map(function (region) {
    return that.killCancel(region, [], spotReqs[region].map(function (sr) {
      debug('killing stalled spot request ' + sr.SpotInstanceRequestId);
      return sr.SpotInstanceRequestId;
    }));
  }));
};

/**
 * We want to separate spot requests into two buckets:
 *   - those which are going to be fulfilled quickly
 *   - those which should be canceled because of AWS
 * This function returns an object with the spot requests sorted
 * into these buckets.
 */
AwsManager.prototype._filterSpotRequests = function (spotReqs) {
  var that = this;
  var data = {
    good: {},
    stalled: {},
  };

  var now = new Date();

  Object.keys(spotReqs).forEach(function (region) {
    data.good[region] = [];
    data.stalled[region] = [];

    spotReqs[region].SpotInstanceRequests.forEach(function (sr) {
      // These are states which have a state of 'open' but which
      // are likely not to be fulfilled expeditiously
      var stalledStates = [
        'capacity-not-available',
        'capacity-oversubscribed',
        'price-too-low',
        'not-scheduled-yet',
        'launch-group-constraint',
        'az-group-constraint',
        'placement-group-constraint',
        'constraint-not-fulfillable ',
      ];

      var killWhen = new Date(sr.CreateTime);
      killWhen.setMinutes(killWhen.getMinutes() + 20);

      if (killWhen < now) {
        debug('killing stalled spot request %s because it has not been fulfilled in 20 minutes',
            sr.SpotInstanceRequestId);

        data.stalled[region].push(sr);
      }

      // We've found a spot price floor
      if (sr.Status.Code === 'price-too-low') {
        debug('found a canceled spot request, submitting pricing floor');
        that.reportSpotPriceFloorFound({
          region: region,
          az: sr.LaunchSpecification.Placement.AvailabilityZone,
          instanceType: sr.LaunchSpecification.InstanceType,
          time: dateForInflux(new Date()),
          price: parseFloat(sr.SpotPrice, 10),
          reason: 'spot-request-price-too-low',
        });
      }

      if (stalledStates.includes(sr.Status.Code)) {
        debug('killing stalled spot request %s because it is in bad state %s',
              sr.SpotInstanceRequestId, sr.Status.Code);
        data.stalled[region].push(sr);
      } else {
        data.good[region].push(sr);
      }

    });
  });

  return data;
};

/**
 * Compare two state objects to find the instances and requests which are no
 * longer in the new state object.  The assumption here is that the items that
 * are no longer in the state are those which have been terminated.  This
 * method returns those instances and request which are no longer present in
 * state.  You'll need to have another data source to find the resolution of
 * the now missing resources
 */
AwsManager.prototype._compareStates = function (newState, previousState, deadState) {
  assert(newState);
  assert(previousState);
  assert(deadState);

  var missingIds = {
    instances: [],
    requests: [],
  };

  // to make comparison of states easier, we create a list of all the ids of
  // both spot requests and instances in each of the two compared states
  var allInstancesInPreviousState = previousState.instances.map(function (instance) {
    return instance.InstanceId;
  });
  var allRequestsInPreviousState = previousState.requests.map(function (request) {
    return request.SpotInstanceRequestId;
  });
  var allInstancesInNewState = newState.instances.map(function (instance) {
    return instance.InstanceId;
  });
  var allRequestsInNewState = newState.requests.map(function (request) {
    return request.SpotInstanceRequestId;
  });

  // find all the instances and request ids which were in the previous state
  // but not in the new state
  missingIds.instances = allInstancesInPreviousState.filter(function (id) {
    return !allInstancesInNewState.includes(id);
  });
  missingIds.requests = allRequestsInPreviousState.filter(function (id) {
    return !allRequestsInNewState.includes(id);
  });

  // Now let's grab those instances and requests which are absent, but instead
  // let's use their new state object instead of the old one.  This is to avoid
  // the problem of getting the stale state info in the later methods which
  // need information about why the state change occured
  return {
    instances: deadState.instances.filter(function (instance) {
      return missingIds.instances.includes(instance.InstanceId);
    }),
    requests: deadState.requests.filter(function (request) {
      return missingIds.requests.includes(request.SpotInstanceRequestId);
    }),
  };
};

/**
 * Take a list of instances which are now absent and figure out why they are gone.
 * This will submit Influx points.  Differences are those objects which no longer
 * show up in the 'live' set of ec2 queries, instead show
 *
 * Remember that we're only looking at the differences between iteration intervals.
 * This is how we ensure that we don't look the same spot request twice.
 */
AwsManager.prototype._reconcileStateDifferences = function (differences, deadState, apiState) {
  var that = this;
  assert(differences);
  assert(deadState);
  assert(apiState);

  function plotSpotFulfilment (request) {
    // Once we go from open -> active with a status of fulfilled we can log this
    // spot request as successfully fulfilled.  This does not imply that
    that.reportSpotRequestsFulfilled({
      provisionerId: that.provisionerId,
      region: request.Region,
      az: request.LaunchSpecification.Placement.AvailabilityZone,
      instanceType: request.LaunchSpecification.InstanceType,
      workerType: request.WorkerType,
      id: request.SpotInstanceRequestId,
      instanceId: request.InstanceId,
      time: dateForInflux(request.Status.UpdateTime),
    });
    debug('spot request %j fulfilled!', request);
  }

  // We want to figure out what happened to each of the spot requests which are
  // no longer showing up as pending.  These can either be fulfilled or
  // rejected.  FOr those which are fulfilled we want to create a data point
  // which will let us trend how long spot request fulfilment takes.  For those
  // which fail we want stats on why they failed so we can later analyze this
  differences.requests.forEach(function (request) {
    if (request.State === 'active' && request.Status.Code === 'fulfilled') {
      plotSpotFulfilment(request);
    } else if (request.State === 'open') {
      // Here we have those spot requests which are no longer unfulfilled but
      // do not have an api state which reflects that
      that.__awaitingSpotFulfilmentStatus.push({
        id: request.SpotInstanceRequestId,
        time: new Date(),
        iterationCount: 0,
      });
    } else {
      // I wonder if we should be reporting spot requests which failed because
      // of bid amount here in their own special series for use in trying to
      // figure out what to bid.  We could use refused spot bids as a lower
      // limit for bids
      that.reportSpotRequestsDied({
        provisionerId: that.provisionerId,
        region: request.Region,
        az: request.LaunchSpecification.Placement.AvailabilityZone,
        instanceType: request.LaunchSpecification.InstanceType,
        workerType: request.WorkerType,
        id: request.SpotInstanceRequestId,
        time: dateForInflux(request.Status.UpdateTime),
        bid: parseFloat(request.SpotPrice, 10),
        state: request.State,
        statusCode: request.Status.Code,
        statusMsg: request.Status.Message,
      });
      debug('spot request %j did something else', request);
    }
  });

  this.__awaitingSpotFulfilmentStatus = this.__awaitingSpotFulfilmentStatus.filter(function (requestAwaiting) {
    var keepInTheList = true;

    deadState.requests.forEach(function (requestMightHave) {
      if (requestMightHave.SpotInstanceRequestId === requestAwaiting) {
        if (requestMightHave.State === 'active' && requestMightHave.Status.Code === 'fulfilled') {
          plotSpotFulfilment(requestMightHave);
          keepInTheList = false;
        }
      }
    });

    if (requestAwaiting.iterationCount++ > MAX_ITERATIONS_FOR_STATE_RESOLUTION) {
      debug('dropping spot request on the floor');
      keepInTheList = false;
    }

    return keepInTheList;
  });

  /*
    for instances we need to see if there's a transition reason already and if not,
    we need to store the instance metadata and check on the next iteration whether
    that instance has an associated state transition reason.  For when there is a
    spot price termination, we should also look for a spot request in the good and
    dead ones to see what we bid on the thing.  We should also track what the time
    was when we found the difference and we should only try for up to, say, 5 times
    before we give up on trying to figure out why the instance terminated.

    http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StateReason.html
  */

  function plotInstanceDeath (instance, time) {
    // Let's track when the instance is shut down
    that.reportInstanceTerminated({
      provisionerId: that.provisionerId,
      region: instance.Region,
      az: instance.Placement.AvailabilityZone,
      instanceType: instance.InstanceType,
      workerType: instance.WorkerType,
      id: instance.InstanceId,
      spotRequestId: instance.SpotInstanceRequestId,
      time: dateForInflux(time),
      launchTime: dateForInflux(instance.LaunchTime),
      stateCode: instance.State.Code,
      stateMsg: instance.State.Name,
      stateChangeCode: instance.StateReason.Code,
      stateChangeMsg: instance.StateReason.Message,
    });

    if (instance.StateReason.Code === 'Server.SpotInstanceTermination') {
      debug('We have a spot price floor!');
      // Let's figure out what we set the price to;
      var price;

      deadState.requests.forEach(function (request) {
        if (!price && request.SpotInstanceRequestId === instance.SpotInstanceRequestId) {
          price = parseFloat(request.SpotPrice, 10);
        }
      });

      apiState.requests.forEach(function (request) {
        if (!price && request.SpotInstanceRequestId === instance.SpotInstanceRequestId) {
          price = parseFloat(request.SpotPrice, 10);
        }
      });

      if (price) {
        that.reportSpotPriceFloorFound({
          region: instance.Region,
          az: instance.Placement.AvailabilityZone,
          instanceType: instance.InstanceType,
          time: new Date().toISOString(),
          price: price,
          reason: 'instance-spot-killed',
        });
      } else {
        debug('Could not find a price for a spot-price killed instance');
      }
    }
  }

  // Let's handle instance which already have a state reason, or
  // save them for a future iteration if not
  differences.instances.forEach(function (instance) {
    // Using StateReason instead of StateTransitionReason
    if (instance.StateReason && instance.StateReason.Code) {
      debug('found a terminated instance which has a termination reason');
      plotInstanceDeath(instance, new Date().toISOString());
    } else {
      debug('found a terminated instance which awaits a termination reason');
      that.__awaitingStateReason.push({
        id: instance.InstanceId,
        time: new Date().toISOString(),
        iterationCount: 0,
      });
    }
  });

  // Now, let's try to account for those instance which are awaiting a state reason
  this.__awaitingStateReason = this.__awaitingStateReason.filter(function (instanceAwaiting) {
    var keepItInTheList = true;
    deadState.instances.forEach(function (instanceMightHave) {
      if (instanceMightHave.InstanceId === instanceAwaiting.id) {
        if (instanceMightHave.StateReason && instanceMightHave.StateReason.Code) {
          keepItInTheList = false;
          // Notice how we're plotting the newly fetched instance since it's
          // the one that's going to have the StateReason
          debug('found an instance awaiting reason to plot');
          plotInstanceDeath(instanceMightHave, instanceAwaiting.time);
        }
      }
    });

    // We don't want to track this stuff forever!
    if (instanceAwaiting.iterationCount++ > MAX_ITERATIONS_FOR_STATE_RESOLUTION) {
      keepItInTheList = false;
      debug('exceeded the number of iterations awaiting reason');
    }

    return keepItInTheList;
  });
};

/**
 * Instead of defining these lists in lots of places, let's ensure
 * that we use the same filters in all places!
 */

AwsManager.prototype.filters = {
  spotReq: [
    'CreateTime',
    'State',
    'LaunchSpecification:InstanceType',
    'LaunchSpecification:ImageId',
    'LaunchSpecification:Placement:AvailabilityZone',
    'SpotInstanceRequestId',
    'Tags',
    'Status:Code',
    'Status:UpdateTime',
    'Status:Message',
  ],
  instance: [
    'InstanceId',
    'ImageId',
    'InstanceType',
    'LaunchTime',
    'Placement:AvailabilityZone',
    'SpotInstanceRequestId',
    'State:Name',
    'Tags',
  ],
};

/**
 * Classify the state received from AWS into something in the shape:
 * {
 *   region: {
 *     workerTypeName: {
 *       running: [<Instance>],
 *       pending: [<Instance>],
 *       spotReq: [<SpotRequest>],
 *     }
 *   }
 * }
 * The Instance and SpotRequest objects are those returned by AWS.
 * We flatten the Reservations because we don't really care about that
 * feature right now.
 */
AwsManager.prototype._classify = function (instanceState, spotReqs) {
  var that = this;

  /* In the new world, we're just going to store a pair of lists.
     One list for all intances regardless of region or state and
     one list for all spot requests regardless of region or state.
     These lists will be filtered when we need per-region or per-
     workerType lists */
  var state = {
    instances: [],
    requests: [],
  };

  that.ec2.regions.forEach(function (region) {
    instanceState[region].Reservations.forEach(function (reservation) {
      reservation.Instances.forEach(function (instance) {
        var workerType = instance.KeyName.substr(that.keyPrefix.length);
        // XXX var filtered = objFilter(instance, that.filters.instance);
        var filtered = instance;
        filtered.Region = region;
        filtered.WorkerType = workerType;
        state.instances.push(filtered);
      });
    });

    spotReqs[region].forEach(function (request) {
      var workerType = request.LaunchSpecification.KeyName.substr(that.keyPrefix.length);
      // XXX var filtered = objFilter(request, that.filters.spotReq);
      var filtered = request;
      filtered.Region = region;
      filtered.WorkerType = workerType;
      state.requests.push(filtered);
    });

  });

  return state;
};

/** Return a list of all Instances for a region */
AwsManager.prototype.instancesInRegion = function (region) {
  if (typeof region === 'string') {
    region = [region];
  }
  return this.__apiState.instances.filter(function (instance) {
    return region.includes(instance.Region);
  });
};

/** Return a list of all SpotRequests for a region */
AwsManager.prototype.requestsInRegion = function (region) {
  if (typeof region === 'string') {
    region = [region];
  }
  return this.__apiState.requests.filter(function (request) {
    return region.includes(request.Region);
  });
};

/** Return a list of all Instances for a workerType */
AwsManager.prototype.instancesOfType = function (workerType) {
  if (typeof workerType === 'string') {
    workerType = [workerType];
  }
  return this.__apiState.instances.filter(function (instance) {
    return workerType.includes(instance.WorkerType);
  });
};

/** Return a list of all SpotRequests for a workerType */
AwsManager.prototype.requestsOfType = function (workerType) {
  if (typeof workerType === 'string') {
    workerType = [workerType];
  }
  return this.__apiState.requests.filter(function (request) {
    return workerType.includes(request.WorkerType);
  });
};

AwsManager.prototype.instancesOfTypeInRegion = function (region, workerType) {
  if (typeof workerType === 'string') {
    workerType = [workerType];
  }
  if (typeof region === 'string') {
    region = [region];
  }
  return this.__apiState.instances.filter(function (instance) {
    return region.includes(instance.Region) && workerType.includes(instance.WorkerType);
  });

};

AwsManager.prototype.requestsOfTypeInRegion = function (region, workerType) {
  if (typeof workerType === 'string') {
    workerType = [workerType];
  }
  if (typeof region === 'string') {
    region = [region];
  }
  return this.__apiState.requests.filter(function (request) {
    return region.includes(request.Region) && workerType.includes(request.WorkerType);
  });

};

/**
 * List all the workerTypes known in state
 */
AwsManager.prototype.knownWorkerTypes = function () {
  var workerTypes = [];

  this.__apiState.instances.forEach(function (instance) {
    if (!workerTypes.includes(instance.WorkerType)) {
      workerTypes.push(instance.WorkerType);
    }
  });

  this.__apiState.requests.forEach(function (request) {
    if (!workerTypes.includes(request.WorkerType)) {
      workerTypes.push(request.WorkerType);
    }
  });

  this.__internalState.forEach(function (sr) {
    if (!workerTypes.includes(sr.request.WorkerType)) {
      workerTypes.push(sr.request.WorkerType);
    }
  });

  return workerTypes;
};

/**
 * Count the capacity of this workerType that are in the states specified
 * by `states`.  Doing this uses the Capacity key from the workerType's
 * types dictionary.  Remember that capacity is the number of tasks
 * that this instance/request will be able to service.
 * If specified, `extraSpotRequests` is a dictionary which contains a region
 * and worker type categorized list of outstanding spot requests
 */
AwsManager.prototype.capacityForType = function (workerType, states) {
  assert(workerType);
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }
  var capacity = 0;
  var instances = this.instancesOfType(workerType.workerType);
  var requests = this.requestsOfType(workerType.workerType);

  instances.forEach(function (instance) {
    if (states.includes(instance.State.Name)) {
      try {
        capacity += workerType.capacityOfType(instance.InstanceType);
      } catch(err) {
        capacity++;
      }
    }
  });

  requests.forEach(function (request) {
    if (states.includes('spotReq')) {
      try {
        capacity += workerType.capacityOfType(request.InstanceType);
      } catch(err) {
        capacity++;
      }
    }
  });

  this.__internalState.forEach(function (sr) {
    if (states.includes('spotReq')) {
      try {
        capacity += workerType.capacityOfType(sr.request.InstanceType);
      } catch(err) {
        capacity++;
      }
    }
  });

  return capacity;

};

/**
 * Ensure (but only at best effort) that all provisioner owned resources
 * are tagged with appropriate tags.  These can be used by others to
 * get detailed pricing data, but they are not, nor should be, used by
 * the provisioner internally
 */
AwsManager.prototype.ensureTags = function () {
  var that = this;

  function missingTags (obj) {
    var hasTag = false;
    if (obj.Tags) {
      obj.Tags.forEach(function (tag) {
        if (tag.Key === 'Owner' && tag.Value === that.provisionerId) {
          hasTag = true;
        }
      });
    }
    return !hasTag;
  }

  var instanceWithoutTags = this.__apiState.instances.filter(missingTags);
  var requestsWithoutTags = this.__apiState.requests.filter(missingTags);

  var tags = {};

  function x (y, id) {
    if (!tags[y.Region]) {
      tags[y.Region] = {};
    }

    if (!tags[y.Region][y.WorkerType]) {
      tags[y.Region][y.WorkerType] = {
        data: [
          {Key: 'Name', Value: y.WorkerType},
          {Key: 'Owner', Value: that.provisionerId},
          {Key: 'WorkerType', Value: that.provisionerId + '/' + y.WorkerType},
        ],
        ids: [id],
      };
    } else {
      tags[y.Region][y.WorkerType].ids.push(id);
    }
  }

  instanceWithoutTags.forEach(function (inst) {
    x(inst, inst.InstanceId);
  });

  requestsWithoutTags.forEach(function (req) {
    x(req, req.SpotInstanceRequestId);
  });

  var createTags = [];

  Object.keys(tags).forEach(function (region) {
    Object.keys(tags[region]).forEach(function (workerType) {
      var p = that.ec2.createTags.inRegion(region, {
        Tags: tags[region][workerType].data,
        Resources: tags[region][workerType].ids,
      });

      p = p.then(function () {
        debug('tagged %s/%s: %j', region, workerType, tags[region][workerType].ids);
      });

      // Creating a tag is on best effort basis
      p = p.catch(function (err) {
        debug('Failed to tag %s/%s: %j', region, workerType, tags[region][workerType].ids);
        debug(err);
        if (err.stack) {
          debug(err.stack);
        }
      });

      createTags.push(p);
    });
  });

  return Promise.all(createTags);
};

/**
 * List every known spot instance request id known to the AWS
 * state.
 */
AwsManager.prototype.knownSpotInstanceRequestIds = function () {
  // We need to know all the SpotInstanceRequestIds which are known
  // to aws state.  This is mostly just the id from the requests
  var allKnownSrIds = this.__apiState.requests.map(function (request) {
    return request.SpotInstanceRequestId;
  });

  // We also want to make sure that the Spot Request isn't in any
  // instance's object
  this.__apiState.instances.forEach(function (instance) {
    var sird = instance.SpotInstanceRequestId;
    if (sird && !allKnownSrIds.includes(sird)) {
      allKnownSrIds.push(sird);
    }
  });

  return allKnownSrIds;
};

/**
 * Because the AWS is eventually consistent, it will sometimes take time for
 * spot requests to show up in the describeSpotInstanceRequests calls for
 * AWS state.  We will maintain an internal table of these submitted but
 * not yet visible spot requests so that we can offset the count of a given
 * instance type for figuring out running capacity.  If the provisioning
 * process is restarted before the spot request shows up in the api's
 * state we will lose track of it until it turns into an instance.
 */
AwsManager.prototype._trackNewSpotRequest = function (sr) {
  // sr is a SpotRequest object which we get back from the
  // AWS Api when we submit the SpotRequest
  assert(sr);

  var allKnownSrIds = this.knownSpotInstanceRequestIds();

  if (!allKnownSrIds.includes(sr.request.SpotInstanceRequestId)) {
    // XXX var filtered = objFilter(sr.request, that.filters.spotReq);
    var filtered = sr.request;
    sr.request = filtered;
    sr.request.Region = sr.bid.region;
    sr.request.WorkerType = sr.workerType;
    this.__internalState.push(sr);
  }

};

/**
 * Once a SpotRequest shows up in the state returned from the AWS api
 * we should remove it from the internal state of spot requests that
 * is needed.  We do this before running the provisioner of each
 * workerType to avoid double counting a newly discovered spot request
 */
AwsManager.prototype._reconcileInternalState = function () {
  // Remove the SRs which AWS now tracks from internal state

  // TODO: This stuff is broken right now
  var that = this;
  var now = new Date();

  // We need to know all the SpotInstanceRequestIds which are known
  // to aws state.  This is mostly just the id from the requests
  var allKnownSrIds = this.knownSpotInstanceRequestIds();

  this.__internalState = this.__internalState.filter(function (request) {
    // We want to print out some info!
    if (allKnownSrIds.includes(request.request.SpotInstanceRequestId)) {
      // Now that it's shown up, we'll remove it from the internal state
      debug('Spot request %s for %s/%s/%s took %d seconds to show up in API',
            request.request.SpotInstanceRequestId, request.request.Region,
            request.request.LaunchSpecification.Placement.AvailabilityZone,
            request.request.LaunchSpecification.InstanceType,
            (now - request.submitted) / 1000);
      that.reportEc2ApiLag({
        provisionerId: that.provisionerId,
        region: request.request.Region,
        az: request.request.LaunchSpecification.Placement.AvailabilityZone,
        instanceType: request.request.LaunchSpecification.InstanceType,
        workerType: request.request.WorkerType,
        id: request.request.SpotInstanceRequestId,
        didShow: 0,
        lag: (now - request.submitted) / 1000,
      });
      return false;
    } else {
      debug('Spot request %s for %s/%s/%s still not in api after %d seconds',
            request.request.SpotInstanceRequestId, request.request.Region,
            request.request.LaunchSpecification.Placement.AvailabilityZone,
            request.request.LaunchSpecification.InstanceType,
            (now - request.submitted) / 1000);
      // We want to track spot requests which aren't in the API yet for a
      // maximum of 15 minutes.  Any longer and we'd risk tracking these
      // forever, which could bog down the system

      if (now - request.submitted >= 15 * 60 * 1000) {
        that.reportEc2ApiLag({
          provisionerId: that.provisionerId,
          region: request.request.Region,
          az: request.request.LaunchSpecification.Placement.AvailabilityZone,
          instanceType: request.request.LaunchSpecification.InstanceType,
          workerType: request.request.WorkerType,
          id: request.request.SpotInstanceRequestId,
          didShow: 1,
          lag: (now - request.submitted) / 1000,
        });
        return false;
      } else {
        return true;
      }
    }
  });
};

/**
 * Create an instance of a WorkerType and track it.  Internally,
 * we will track the outstanding spot requests until they are seen
 * in the EC2 API.  This makes sure that we don't ignroe spot requests
 * that we've made but not yet seen.  This avoids run-away provisioning
 */
AwsManager.prototype.requestSpotInstance = function (launchInfo, bid) {
  var that = this;
  assert(bid, 'Must specify a spot bid');
  assert(typeof bid.price === 'number', 'Spot Price must be number');

  assert(this.ec2.regions.includes(bid.region));

  var p = this.ec2.requestSpotInstances.inRegion(bid.region, {
    InstanceCount: 1,
    Type: 'one-time',
    LaunchSpecification: launchInfo.launchSpec,
    SpotPrice: bid.price.toString(),
  });

  p = p.then(function (spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    return spotRequest.SpotInstanceRequests[0];
  });

  p = p.then(function (spotReq) {
    debug('submitted spot request %s for $%d for %s in %s/%s for %s',
      spotReq.SpotInstanceRequestId, bid.price, launchInfo.workerType, bid.region, bid.zone, bid.type);
    debug('Used this userdata: %j', launchInfo.userData);

    var info = {
      workerType: launchInfo.workerType,
      request: spotReq,
      bid: bid,
      submitted: new Date(),
    };

    return info;
  });

  p = p.then(function (info) {
    that.reportSpotRequestsSubmitted({
      provisionerId: that.provisionerId,
      region: info.bid.region,
      az: info.bid.zone,
      instanceType: info.bid.type,
      workerType: info.workerType,
      id: info.request.SpotInstanceRequestId,
      bid: bid.price,
      price: bid.truePrice,  // ugh, naming!
    });

    that.reportAmiUsage({
      provisionerId: that.provisionerId,
      ami: launchInfo.launchSpec.ImageId,
      region: info.bid.region,
      az: info.bid.zone,
      instanceType: info.bid.type,
      workerType: info.workerType,
    });

    that._trackNewSpotRequest(info);
  });

  return p;
};

/**
 * We use KeyPair names to determine ownership and workerType
 * in the EC2 world because we can't tag SpotRequests until they've
 * mutated into Instances.  This sucks and all, but hey, what else
 * can we do?  This method checks which regions have the required
 * KeyPair already and creates the KeyPair in regions which do not
 * already have it.  Note that the __knownKeyPair cache should never
 * become shared, since we rely on it not surviving restarts in the
 * case that we start running this manager in another region.  If
 * we didn't dump the cache, we could create the key in one region
 * but not the new one that we add.  TODO: Look into what happens
 * when we add a region to the list of allowed regions... I suspect
 * that we'll end up having to track which regions the workerName
 * is enabled in.
 */
AwsManager.prototype.createKeyPair = function (workerName) {
  assert(workerName);
  var that = this;
  var keyName = this.keyPrefix + workerName;

  if (this.__knownKeyPairs.includes(workerName)) {
    // Short circuit checking for a key but return
    // a promise so this cache is invisible to the
    // calling function from a non-cached instance
    return Promise.resolve();
  }

  var p = this.ec2.describeKeyPairs.inRegions(this.ec2.regions, {
    Filters: [
      {
        Name: 'key-name',
        Values: [keyName],
      },
    ],
  });

  p = p.then(function (res) {
    var toCreate = [];

    that.ec2.regions.forEach(function (region) {
      var matchingKey = res[region].KeyPairs[0];
      if (!matchingKey) {
        debug('creating missing key %s in %s', keyName, region);
        toCreate.push(that.ec2.importKeyPair.inRegion(region, {
          KeyName: keyName,
          PublicKeyMaterial: that.pubKey,
        }));
      }
    });
    return Promise.all(toCreate);
  });

  p = p.then(function () {
    that.__knownKeyPairs.push(workerName);
  });

  return p;
};

/**
 * Delete a KeyPair when it's no longer needed.  This method
 * does nothing more and you shouldn't run it until you've turned
 * everything off.
 */
AwsManager.prototype.deleteKeyPair = function (workerName) {
  assert(workerName);
  var that = this;

  var keyName = this.keyPrefix + workerName;

  var p = this.ec2.describeKeyPairs({
    Filters: [
      {
        Name: 'key-name',
        Values: [keyName],
      },
    ],
  });

  p = p.then(function (res) {
    return Promise.all(that.ec2.regions.filter(function (region) {
      return !!res[region].KeyPairs[0];
    }).map(function (region) {
      debug('deleting key %s in %s', keyName, region);
      return that.ec2.deleteKeyPair.inRegion(region, {
        KeyName: keyName,
      });
    }));
  });

  p = p.then(function () {
    that.__knownKeyPairs = that.__knownKeyPairs.filter(function (knownKeyPair) {
      return knownKeyPair !== workerName;
    });
  });

  return p;
};

/**
 * Rouge Killer.  A rouge is an instance that has a KeyPair name
 * that belongs to this provisioner but is not present in the list
 * of workerNames provided.  We can also use this to shut down all
 * instances of everything if we just pass an empty list of workers
 * which will say to this function that all workerTypes are rouge.
 * Sneaky, huh?
 */
AwsManager.prototype.rougeKiller = function (configuredWorkers) {
  assert(configuredWorkers);
  var that = this;
  var workersInState = this.knownWorkerTypes();
  var rouge = [];

  workersInState.filter(function (name) {
    return !configuredWorkers.includes(name);
  }).forEach(function (name) {
    debug('found a rouge workerType: %s, killing all instances and requests', name);
    rouge.push(that.deleteKeyPair(name));
    rouge.push(that.killByName(name));
  });

  return Promise.all(rouge);
};

/**
 * Kill all instances in all regions of a given workerName.
 */
AwsManager.prototype.killByName = function (name, states) {
  var deaths = [];
  var that = this;
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }

  var perRegionKills = {};

  this.ec2.regions.forEach(function (region) {
    perRegionKills[region] = {
      instances: [],
      requests: [],
    };
  });

  this.__apiState.instances.forEach(function (instance) {
    if (instance.WorkerType === name && states.includes(instance.State.Name)) {
      perRegionKills[instance.Region].instances.push(instance.InstanceId);
    }
  });

  this.__apiState.requests.forEach(function (request) {
    if (request.WorkerType === name && states.includes('spotReq')) {
      perRegionKills[request.Region].requests.push(request.SpotInstanceRequestId);
    }
  });

  this.__internalState.forEach(function (sr) {
    if (sr.request.WorkerType === name && states.includes('spotReq')) {
      perRegionKills[sr.request.Region].requests.push(sr.request.SpotInstanceRequestId);
    }

  });

  Object.keys(perRegionKills).forEach(function (region) {
    var i = perRegionKills[region].instances;
    var r = perRegionKills[region].requests;
    debug('killing all %s in states %j in %s\nInstances: %j\nRequests: %j',
        name, states, region, i, r);
    deaths.push(that.killCancel(region, i, r));
  });

  return Promise.all(deaths);
};

/**
 * Kill instances and cancel spot requests
 */
AwsManager.prototype.killCancel = function (region, instances, requests) {
  assert(instances || requests);
  var that = this;

  var promises = [];
  var i = instances || [];
  var r = requests || [];

  if (i.length > 0) {
    debug('killing instances %s in %j', i, region);
    promises.push(that.ec2.terminateInstances.inRegion(region, {
      InstanceIds: i,
    }));
  }

  if (r.length > 0) {
    debug('cancelling spot requests %j in %s', r, region);
    promises.push(that.ec2.cancelSpotInstanceRequests.inRegion(region, {
      SpotInstanceRequestIds: r,
    }));
  }

  return Promise.all(promises);
};

/**
 * Kill spot requests to change negatively by a capacity unit change.
 * We use this function to do things like canceling spot requests that
 * exceed the number we require.
 */
AwsManager.prototype.killCapacityOfWorkerType = function (workerType, count, states) {
  var that = this;
  assert(workerType);
  assert(typeof count === 'number');
  assert(states);

  // Capacities, by instance type
  var caps = {};

  // Build the mapping of capacity to instance type string
  workerType.instanceTypes.forEach(function (t) {
    caps[t.instanceType] = workerType.capacityOfType(t.instanceType);
  });

  var capacity = this.capacityForType(workerType, states);
  var capToKill = 0;

  // Should we continue?
  function cont () {
    return count <= capToKill && capacity - capToKill >= workerType.minCapacity;
  }

  // Set up the storage for storing instance and sr ids by
  // region so we can cancel them easily later
  var toKill = {};
  this.ec2.regions.forEach(function (region) {
    toKill[region] = {
      instances: [],
      requests: [],
    };
  });

  // Now, let's go through the states starting with spot requests.
  if (states.includes('spotReq')) {
    // Let's shuffle things!
    var shuffledRequests = shuffle.knuthShuffle(this.requestsOfType(workerType.workerType));
    shuffledRequests.forEach(function (request) {
      if (cont()) {
        capToKill += caps[request.LaunchSpecification.InstanceType] || 1;
        toKill[request.Region].push(request.SpotInstanceRequestId);
      }
    });

    // Remember that we do internal state a little differently
    this.__internalState.forEach(function (sr) {
      if (cont() && sr.request.WorkerType === workerType.workerType) {
        capToKill += caps[sr.request.LaunchSpecification.InstanceType] || 1;
        toKill[sr.request.Region].push(sr.request.SpotInstanceRequestId);
      }
    });
  }

  var shuffledApiInstances = shuffle.knuthShuffle(this.instancesOfType(workerType.workerType));
  shuffledApiInstances.forEach(function (instance) {
    if (cont() && states.includes(instance.State.Name)) {
      capToKill += caps[instance.InstanceType] || 1;
      toKill[instance.Region].push(instance.InstanceId);
    }
  });

  var deaths = [];

  Object.keys(toKill).forEach(function (region) {
    var i = toKill[region].instances;
    var r = toKill[region].requests;
    if (i.length + r.length > 0) {
      debug('killing %d capacity of %s in states %j in %s\nInstances: %j\nRequests: %j',
          capToKill, workerType.workerType, states, region, i, r);
      deaths.push(that.killCancel(region, i, r));
    }
  });

  return Promise.all(deaths);
};

/**
 * Hard kill instances which have lived too long.  This is a safe guard
 * to protect against zombie attacks.  Workers should self impose a limit
 * of 72 hours.
 */
AwsManager.prototype.zombieKiller = function () {
  var that = this;
  var zombies = {};

  var killIfOlderThan = taskcluster.fromNow(this.maxInstanceLife);

  this.__apiState.instances.filter(function (instance) {
    if (instance.LaunchTime) {
      var launchedAt = new Date(instance.LaunchTime);
      return launchedAt < killIfOlderThan;
    } else {
      return false;  // Since we can't know when it started, ignore it
    }
  }).forEach(function (instance) {
    if (!zombies[instance.Region]) {
      zombies[instance.Region] = [];
    }
    zombies[instance.Region].push(instance.InstanceId);
  });

  return Promise.all(Object.keys(zombies).map(function (region) {
    debug('killing zombie instances in %s: %j', region, zombies[region]);
    return that.killCancel(region, zombies[region]);
  }));

};

/**
 * This method is to emulate the old storage format of state for the purposes of
 * not having to update the UI right away.  We don't bother checking internal
 * state since... well... because... I don't feel like explaining why
 */
AwsManager.prototype.emulateOldStateFormat = function () {
  var oldState = {};

  function x (type) {
    if (!oldState[type]) {
      oldState[type] = {
        running: [],
        pending: [],
        spotReq: [],
      };
    }
  }

  this.__apiState.instances.forEach(function (instance) {
    x(instance.WorkerType);
    oldState[instance.WorkerType][instance.State.Name].push(instance);
  });

  this.__apiState.requests.forEach(function (request) {
    x(request.WorkerType);
    oldState[request.WorkerType].spotReq.push(request);
  });

  return oldState;
};
