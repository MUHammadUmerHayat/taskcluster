/**
Primary interface which handles listening for messages and initializing the
execution of tasks.
*/
const TaskQueue = require('./queueservice');
const DeviceManager = require('./devices/device_manager');
const Debug = require('debug');
const { Task } = require('./task');
const { EventEmitter } = require('events');
const { exceedsDiskspaceThreshold } = require('./util/capacity');
const os = require('os');

const debug = Debug('docker-worker:task-listener');

/**
@param {Configuration} config for worker.
*/
class TaskListener extends EventEmitter {
  constructor(runtime) {
    super();
    this.runtime = runtime;
    this.runningTasks = [];
    this.taskQueue = new TaskQueue(this.runtime);
    this.taskPollInterval = this.runtime.taskQueue.pollInterval;
    this.lastTaskEvent = Date.now();
    this.host = runtime.hostManager;
    this.lastKnownCapacity = 0;
    this.totalRunTime = 0;
    this.lastCapacityState = {
      time: new Date(),
      idle: this.lastKnownCapacity,
      busy: this.runningTasks.length,
    };
    this.reportCapacityStateIntervalId = setInterval(
      this.reportCapacityState.bind(this), 60 * 1000,
    );
    this.capacityMonitor = this.runtime.workerTypeMonitor.childMonitor('capacity');
    this.deviceManager = new DeviceManager(runtime);
  }

  async cancelTask(message) {
    let runId = message.payload.runId;
    let reason = message.payload.status.runs[runId].reasonResolved;
    if (reason !== 'canceled') {return;}

    let taskId = message.payload.status.taskId;
    let state = this.runningTasks.find((state) => {
      let { handler } = state;
      return (handler.status.taskId === taskId && handler.runId === runId);
    });

    if (!state) {
      debug('task not found to cancel');
      return;
    }

    this.runtime.log('cancelling task', { taskId: message.payload.status.taskId });
    state.handler.cancel(reason);
    this.cleanupRunningState(state);
  }

  async availableCapacity() {
    // Note: Sometimes capacity could be zero (dynamic capacity changes based on
    // shutdown and other factors) so subtracting runningTasks could result in a
    // negative number, hence the use of at least returning 0.
    let deviceCapacity;
    try {
      deviceCapacity = await this.deviceManager.getAvailableCapacity();
    }
    catch (e) {
      // If device capacity ccannot be determined for device managers configured
      // for the worker, then default to 0
      this.runtime.log('[alert-operator] error determining device capacity',
        {
          message: e.toString(),
          err: e,
          stack: e.stack,
        },
      );

      deviceCapacity = 0;
    }

    let runningCapacity = Math.max(this.runtime.capacity - this.runningTasks.length, 0);
    let hostCapacity = Math.min(runningCapacity, deviceCapacity);
    this.lastKnownCapacity = hostCapacity;

    if (hostCapacity < runningCapacity) {
      this.runtime.log('[info] host capacity adjusted',
        {
          message: 'The available running capacity of the host has been changed.' +
                   ` Available Capacities: Device: ${deviceCapacity} ` +
                   `Running: ${runningCapacity} Adjusted Host Capacity: ${hostCapacity}`,
        },
      );
    }

    return hostCapacity;
  }

  async getTasks() {
    let availableCapacity = await this.availableCapacity();
    if (availableCapacity === 0) {
      debug('not calling claimWork because capacity is zero');
      return;
    }

    // Run a garbage collection cycle to clean up containers and release volumes.
    // Only run a full garbage collection cycle if no tasks are running.
    await this.runtime.gc.sweep(this.runningTasks.length === 0);

    let exceedsThreshold = await exceedsDiskspaceThreshold(
      this.runtime.dockerVolume,
      this.runtime.capacityManagement.diskspaceThreshold,
      availableCapacity,
      this.runtime.log,
      this.runtime.monitor,
    );
    // Do not claim tasks if not enough resources are available
    if (exceedsThreshold) {
      debug('not calling claimWork because not enough disk space');
      return;
    }

    let claims = await this.taskQueue.claimWork(availableCapacity);

    if (claims.length !== 0) {
      // only purge caches if we're about to start a task; this avoids calling
      // purge-cache on every getTasks loop
      await this.runtime.volumeCache.purgeCaches();

      // call runTask for each task, but do not wait for the promise to complete;
      // runTask handles its own errors
      claims.map(claim => this.runTask(claim));
    }
  }

  // Poll for tasks.  This happens periodically, even in cases where we have no capacity
  // for new tasks (in which case getTasks returns immediately).
  async taskPoll() {
    try {
      await this.getTasks();
    } catch (e) {
      this.runtime.log('[alert-operator] task retrieval error', {
        message: e.toString(),
        err: e,
        stack: e.stack,
      });
    }

    // report idle/working state to the shutdown manager
    if (this.isIdle()) {
      this.runtime.shutdownManager.onIdle();
    } else {
      this.runtime.shutdownManager.onWorking();
    }

    // check for any reasons we might want to shut down in between claim
    // attempts.
    switch (this.runtime.shutdownManager.shouldExit()) {
      case 'immediate':
        this.runtime.monitor.count('spotTermination');

        // abruptly terminate existing jobs
        for (let state of this.runningTasks) {
          try {
            state.handler.abort('worker-shutdown');
          } catch (e) {
            debug(`error aborting with worker-shutdown: ${e}`);
            // ignore error in production; queue will treat it as claim-expired
          }
          this.cleanupRunningState(state);
        }

        // wait until all tasks are finished..
        while (!this.isIdle()) {
          await new Promise(res => setTimeout(res, 100));
        }

        // terminate the worker
        await this.shutdown();
        break;

      case 'graceful':
        // stop accepting new jobs
        this.runtime.capacity = 0;

        // if we're idle, shut down now, otherwise keep polling
        if (this.isIdle()) {
          await this.shutdown();
        }
        break;
    }
  }

  scheduleTaskPoll(nextPoll = this.taskPollInterval) {
    if (this.paused) {
      return;
    }

    this.pollTimeoutId = setTimeout(() => {
      this.taskPoll()
        .catch(err => {
          this.runtime.log('error polling tasks', {
            message: err.toString(),
            err: err,
            stack: err.stack,
          });
        })
        .then(() => this.scheduleTaskPoll());
    }, nextPoll);
  }

  async connect() {
    debug('begin consuming tasks');

    this.runtime.logEvent({
      eventType: 'instanceBoot',
      timestamp: Date.now() - (os.uptime() * 1000),
    });

    this.runtime.logEvent({ eventType: 'workerReady' });

    // Scheduled the next poll very soon use the error handling it provides.
    this.scheduleTaskPoll(1);
  }

  async close() {
    await this.pause();
    clearInterval(this.reportCapacityStateIntervalId);
  }

  /**
  Halt the flow of incoming tasks (but handle existing ones).
  */
  async pause() {
    this.paused = true;
    clearTimeout(this.pollTimeoutId);
  }

  /**
  Resume the flow of incoming tasks.
  */
  async resume() {
    this.paused = false;
    this.scheduleTaskPoll();
  }

  /**
   * Shut down the worker
   */
  async shutdown() {
    // stop accepting new tasks
    await this.pause();

    // (just in case..)
    this.runtime.capacity = 0;

    // send several historical log messages
    this.runtime.log('shutdown');
    this.runtime.logEvent({ eventType: 'instanceShutdown' });
    this.runtime.log('exit');

    // defer to the host impelementation to actually shut down
    await this.host.shutdown();
  }

  isIdle() {
    return this.runningTasks.length === 0;
  }

  /**
  Cleanup state of a running container (should apply to all states).
  */
  cleanupRunningState(state) {
    if (!state) {return;}

    if (state.devices) {
      for (let device of Object.keys(state.devices || {})) {
        state.devices[device].release();
      }
    }
  }

  recordCapacity () {
    this.runtime.monitor.measure(
      'capacity.duration.lastTaskEvent',
      Date.now() - this.lastTaskEvent,
    );

    this.runtime.monitor.count('capacity.idle', this.lastKnownCapacity);
    this.runtime.monitor.count('capacity.runningTasks', this.runningTasks.length);
    this.runtime.monitor.count(
      'capacity.total',
      this.lastKnownCapacity + this.runningTasks.length,
    );
    this.lastTaskEvent = Date.now();
  }

  addRunningTask(runningState) {
    //must be called before the task is added
    this.recordCapacity();

    this.runningTasks.push(runningState);
  }

  removeRunningTask(runningState) {
    let taskIndex = this.runningTasks.findIndex((runningTask) => {
      return (runningTask.taskId === runningState.taskId) &&
        (runningTask.runId === runningState.runId);
    });

    if (taskIndex === -1) {
      this.runtime.log('[warning] running task removal error', {
        taskId: runningState.taskId,
        runId: runningState.runId,
        err: 'Could not find the task Id in the list of running tasks',
      });
      this.cleanupRunningState(runningState);
      return;
    }
    //must be called before the task is spliced away
    this.recordCapacity();

    this.cleanupRunningState(runningState);
    this.totalRunTime += Date.now() - runningState.startTime;
    this.runningTasks.splice(taskIndex, 1);
    this.lastKnownCapacity += 1;
  }

  reportCapacityState() {
    let state = {
      time: new Date(),
      idle: this.lastKnownCapacity,
      busy: this.runningTasks.length,
    };
    let time = (
      state.time.getTime() - this.lastCapacityState.time.getTime()
    ) / 1000;
    this.capacityMonitor.count('capacity-busy', this.lastCapacityState.busy * time);
    this.capacityMonitor.count('capacity-idle', this.lastCapacityState.idle * time);
    if (this.lastCapacityState.busy === 0) {
      this.capacityMonitor.count('running-eq-0', time);
    }
    if (this.lastCapacityState.busy >= 1) {
      this.capacityMonitor.count('running-ge-1', time);
    }
    if (this.lastCapacityState.busy >= 2) {
      this.capacityMonitor.count('running-ge-2', time);
    }
    if (this.lastCapacityState.busy >= 3) {
      this.capacityMonitor.count('running-ge-3', time);
    }
    if (this.lastCapacityState.busy >= 4) {
      this.capacityMonitor.count('running-ge-4', time);
    }
    if (this.lastCapacityState.busy >= 6) {
      this.capacityMonitor.count('running-ge-6', time);
    }
    if (this.lastCapacityState.busy >= 8) {
      this.capacityMonitor.count('running-ge-8', time);
    }

    if (this.lastCapacityState.idle === 0) {
      this.capacityMonitor.count('idle-eq-0', time);
    }
    if (this.lastCapacityState.idle >= 1) {
      this.capacityMonitor.count('idle-ge-1', time);
    }
    if (this.lastCapacityState.idle >= 2) {
      this.capacityMonitor.count('idle-ge-2', time);
    }
    if (this.lastCapacityState.idle >= 3) {
      this.capacityMonitor.count('idle-ge-3', time);
    }
    if (this.lastCapacityState.idle >= 4) {
      this.capacityMonitor.count('idle-ge-4', time);
    }
    if (this.lastCapacityState.idle >= 6) {
      this.capacityMonitor.count('idle-ge-6', time);
    }
    if (this.lastCapacityState.idle >= 8) {
      this.capacityMonitor.count('idle-ge-8', time);
    }
    this.lastCapacityState = state;

    let totalRunTime = this.totalRunTime;
    this.runningTasks.forEach(task => {
      totalRunTime += Date.now() - task.startTime;
    });

    let uptime = this.host.billingCycleUptime();
    let efficiency = (totalRunTime / (this.runtime.capacity * (uptime * 1000))) * 100;
    this.runtime.log(
      'reporting efficiency',
      { efficiency, uptime, totalRunTime, capacity: this.capcity });
    this.runtime.workerTypeMonitor.measure('total-efficiency', efficiency);
  }

  /**
  * Run task that has been claimed.
  */
  async runTask(claim) {
    let runningState;
    let task;

    try {

      // Reference to state of this request...
      runningState = {
        startTime: Date.now(),
        devices: {},
        taskId: claim.status.taskId,
        runId: claim.runId,
      };

      this.runtime.log(
        'run task',
        {
          taskId: runningState.taskId,
          runId: runningState.runId,
        },
      );

      // Look up full task definition in claim response.
      task = claim.task;

      // Date when the task was created.
      let created = new Date(task.created);

      // Only record this value for first run!
      if (!claim.status.runs.length) {
        // Record a stat which is the time between when the task was created and
        // the first time a worker saw it.
        this.runtime.monitor.measure('timeToFirstClaim', Date.now() - created);
      }

      let options = {};
      if (this.runtime.restrictCPU) {
        runningState.devices['cpu'] = this.deviceManager.getDevice('cpu');
        options.cpusetCpus = runningState.devices['cpu'].id;
      }

      let taskCapabilities = task.payload.capabilities || {};
      if (taskCapabilities.devices) {
        options.devices = {};
        debug('Aquiring task payload specific devices');

        for (let device of Object.keys(taskCapabilities.devices || {})) {
          runningState.devices[device] = await this.deviceManager.getDevice(device);
          options.devices[device] = runningState.devices[device];
        }
      }

      // Create "task" to handle all the task specific details.
      let taskHandler = new Task(this.runtime, task, claim, options);
      runningState.handler = taskHandler;

      this.addRunningTask(runningState);

      // Run the task and collect runtime metrics.
      try {
        this.runtime.logEvent({
          eventType: 'taskQueue',
          task: taskHandler,
          timestamp: new Date(task.created).getTime(),
        });

        this.runtime.logEvent({
          eventType: 'taskStart',
          task: taskHandler,
        });

        await taskHandler.start();
      } finally {
        this.runtime.logEvent({
          eventType: 'taskFinish',
          task: taskHandler,
        });
      }

      this.removeRunningTask(runningState);
    }
    catch (e) {
      this.removeRunningTask(runningState);
      if (task) {
        this.runtime.log('task error', {
          taskId: claim.status.taskId,
          runId: task.runId,
          message: e.toString(),
          stack: e.stack,
          err: e,
        });
      } else {
        this.runtime.log('task error', {
          message: e.toString(),
          err: e,
        });
      }
    }

    this.runtime.monitor.count('task.error');
  }
}

module.exports = TaskListener;
