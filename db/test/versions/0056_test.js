const _ = require('lodash');
const helper = require('../helper');
const assert = require('assert');
const testing = require('taskcluster-lib-testing');

const THIS_VERSION = parseInt(/.*\/0*(\d+)_test\.js/.exec(__filename)[1]);

suite(testing.suiteName(), function() {

  // A helper to make it easier to create tasks with dummy values within queries
  const makeFieldsForCreation = (opts) => {
    const pp = opts.provisionerId || `'pp'`;
    const wt = opts.workerType || `'wt'`;
    let result = `${opts.taskId || `'tid'`}, ${opts.provisionerId || `'pp'`}, ${wt},
            'sid', 'tgid', jsonb_object('{}'), 'all-completed',
            jsonb_object('{}'), 'normal', 0, now(), now(), now(), jsonb_object('{}'),
            jsonb_object('{}'), jsonb_object('{}'), jsonb_object('{}'),
            jsonb_object('{}')`;
    if (opts.withDefaults) {
      const tqid = `${pp} || '/' || ${wt}`;
      result += `, 0, jsonb_build_array(), null, false, ${tqid}`;
    }
    return result;
  };

  helper.withDbForVersion();

  helper.dbVersionTest({
    version: THIS_VERSION,
    onlineMigration: false,
    onlineDowngrade: true,
    createData: async client => {
      // create the data including a task_queue_id that must be the
      // combined identifier of provisioner_id/worker_type.
      // this is a safe assumption as tested for the previous version.
      await client.query(`
        with gen as (
          select generate_series(1, 99) as i
        )
        insert into tasks (task_id,
                           provisioner_id,
                           worker_type,
                           scheduler_id,
                           task_group_id,
                           dependencies,
                           requires,
                           routes,
                           priority,
                           retries,
                           created,
                           deadline,
                           expires,
                           scopes,
                           payload,
                           metadata,
                           tags,
                           extra,
                           retries_left,
                           runs,
                           taken_until,
                           ever_resolved,
                           task_queue_id)
        select ${makeFieldsForCreation({ taskId: `'tid-' || gen.i`, workerType: `'wt-' || gen.i`, withDefaults: true })}
        from gen`);
    },
    startCheck: async client => {
      const res = await client.query('select task_id, task_queue_id from tasks');
      const nextTaskId = res.rows.length + 1;
      assert(nextTaskId >= 100, 'data was not created properly');
      const tqids = res.rows.map(({ task_queue_id }) => task_queue_id).sort();
      assert.deepEqual(tqids, _.range(1, nextTaskId).map(i => `pp/wt-${i}`).sort());

      // check the schema
      await helper.assertTableColumn('tasks', 'task_queue_id');
    },
    concurrentCheck: async client => {
      // check that the inserted data looks as expected
      const res = await client.query('select task_id, task_queue_id from tasks');
      const nextTaskId = res.rows.length + 1;
      const tids = res.rows.map(({ task_id }) => task_id).sort();
      assert.deepEqual(tids, _.range(1, nextTaskId).map(i => `tid-${i}`).sort());
      const tqids = res.rows.map(({ task_queue_id }) => task_queue_id).sort();
      assert.deepEqual(tqids, _.range(1, nextTaskId).map(i => `pp/wt-${i}`).sort());

      // check functions that use provisioner_id and worker_type (which should still work during an online downgrade)
      // check that create_task works as expected
      const taskOpts = {
        taskId: `'tid-${nextTaskId}'`,
        provisionerId: `'pp'`,
        workerType: `'wt-${nextTaskId}'`,
      };
      await client.query(`select create_task(${makeFieldsForCreation(taskOpts)})`);

      // check that we can use get_task to retrieve the task we just created
      const taskRes = await client.query(`
        select task_id, provisioner_id, worker_type from get_task(${taskOpts.taskId})
      `);
      const expectedTask = {
        task_id: `tid-${nextTaskId}`,
        provisioner_id: 'pp',
        worker_type: `wt-${nextTaskId}`,
      };
      assert.deepEqual(taskRes.rows[0], expectedTask,
        'the last task created with create_task could not be retrieved with get_task');
    },
    finishedCheck: async client => {
      // check that task_queue_id values are as expected
      // this may be somewhat redundant with what's checked in the concurrentCheck
      // but it doesn't hurt
      const res = await client.query('select task_queue_id from tasks');
      const nextTaskId = res.rows.length + 1;
      const tqids = res.rows.map(({ task_queue_id }) => task_queue_id).sort();
      assert.deepEqual(tqids, _.range(1, nextTaskId).map(i => `pp/wt-${i}`).sort());

      // check the schema
      // we expect provisioner_id and worker_type to have been dropped
      await helper.assertNoTableColumn('tasks', 'provisioner_id');
      await helper.assertNoTableColumn('tasks', 'worker_type');
      await helper.assertTableColumn('tasks', 'task_queue_id');
    },
  });
});
