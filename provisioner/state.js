'use strict';

var base = require('taskcluster-base');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:state-storage')
var taskcluster = require('taskcluster-client');

var THE_KEY = 'aws-state';

/**
  An Instance State object stores the lifecycle transitions for a given spot request.
  It has the times when all the relevant state-transitions occured.  These are:

    * pending -> running
    * running -> shutting-down
    * shutting-down -> terminated

  We are ignoring EBS backed nodes for the time being, but they also have started and stopped states

  Because we only check the API for these updates once every few seconds, we'll actually assume that
  they all happen in order and that if we miss a transition that we'll assume the time of the following
  transition.


  Useful reading:

  * http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceState.html
  * http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StateReason.html

 */


var InstanceState = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.StringKey('Region'),
  rowKey: base.Entity.keys.StringKey('InstanceId'),

  properties: {
    // Mirror some basic data to make displaying state easier
    InstanceId: base.Entity.types.String,
    ImageId: base.Entity.types.String,
    InstanceType: base.Entity.types.String,
    LaunchTime: base.Entity.types.Date,
    AZ: base.Entity.types.String,
    Region: base.Entity.types.String,
    WorkerType: base.Entity.types.String,
    SpotInstanceRequestId: base.Entity.types.String,
    // Store state transition times
    // this should be a list of objects in the shape:
    //   { from: 'pending', to: 'running', date: new Date().toISOString(), reason: 'Server.SpotInstanceTermination' }
    // We will eventually create our own internal state of 'accepting-jobs' to be able to track how
    // long it takes from submitted -> accepting jobs
    Transitions: base.Entity.types.JSON,
    // Store the AWS reason for termination
    AwsKilledReason: base.Entity.types.JSON,
    // If the provisioner kills this instance, we will store
    // the reason why the provisioner thinks it should die.
    ProvisionerKilledReason: base.Entity.types.JSON,
  },
});

module.exports.InstanceState = InstanceState;

/**
  Store information and state about a spot request as well as some information for the UI.  Because
  we have infrastructure in place to automatically cancel spot requests which have 'stalled',
  we're only really concerning ourselves with the most recent of each state change.  Like instance
  state, we're going to 


 */

var SpotRequestState = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.StringKey('Region'),
  rowKey: base.Entity.keys.StringKey('SpotInstanceRequestId'),

  properties: {
    // Mirror some basic data to make displaying state easier
    SpotInstanceRequestId: base.Entity.types.String,
    CreateTime: base.Entity.types.Date,
    InstanceId: base.Entity.types.String,
    ImageId: base.Entity.types.String,
    InstanceType: base.Entity.types.String,
    AZ: base.Entity.types.String,
    Region: base.Entity.types.String,
    WorkerType: base.Entity.types.String,
    // Store state transition times.  For spot requests, we need to make sure that
    // we have a transition recorded when the status changes as well as state transitions
    // this should be a list of objects in the shape:
    //   { from: 'open', to: 'close', date: new Date().toISOString(), status: 'pending-fulfilment' }
    Transitions: base.Entity.types.JSON,
    // Store the AWS reason for termination
    AwsKilledReason: base.Entity.types.JSON,
    // If the provisioner kills this instance, we will store
    // the reason why the provisioner thinks it should die.
    ProvisionerKilledReason: base.Entity.types.JSON,
  },
});

module.exports.SpotRequestState = SpotRequestState;
