'use strict'
var cont = require('cont')
var pull = require('pull-stream')
var PullCont = require('pull-cont')
var path = require('path')
var Obv = require('obv')
var explain = require('explain-error')
var Looper = require('pull-looper')
var paramap = require('pull-paramap')

//take a log, and return a log driver.
//the log has an api with `read`, `get` `since`

var wrap = require('./wrap')

function map(obj, iter) {
  var o = {}
  for(var k in obj)
    o[k] = iter(obj[k], k, obj)
  return o
}

function asyncify () {
  return function (read) {
    return function (abort, cb) {
      setImmediate(function () {
        read(abort, cb)
      })
    }
  }
}

module.exports = function (log, isReady, mapper) {

  var views = []
  var meta = {}

  log.get = count(log.get, 'get')

  function count (fn, name) {
    meta[name] = meta[name] || 0
    return function (a, b) {
      meta[name] ++
      fn.call(this, a, b)
    }
  }

  var mapStream = (opts) => {
    var hasSeqs = !!opts.seqs
    var hasNoValues = (data) => {
      // XXX: Is this right? Sometimes `opts.value === true` but `data` is still
      // a number rather than an object. Not sure how to handle this best.
      return !opts.values || 'number' === typeof data
    }
    var getValue
    var setValue

    if (opts.seqs) {
      getValue = (data) => data.value
      setValue = (data, value) => {
        data.value = value
        return data
      }
    } else {
      getValue = (data) => data
      setValue = (data, value) => value
    }

    return paramap((data, cb) => {
      var err = null

      if (hasNoValues(data))
        return cb(err, data)

      mapper(getValue(data), (value) => {
        cb(err, setValue(data, value))
      })
    })
  }

  var ready = Obv()
  ready.set(isReady !== undefined ? isReady : true)
  var flume = {
    closed: false,
    dir: log.filename ? path.dirname(log.filename) : null,
    //stream from the log
    since: log.since,
    ready: ready,
    meta: meta,
    append: function (value, cb) {
      return log.append(value, cb)
    },
    use: function (name, createView) {
      if(~Object.keys(flume).indexOf(name))
        throw new Error(name + ' is already in use!')

      var sv = createView(log, name)

      views[name] = flume[name] = wrap(sv, log.since, ready)
      meta[name] = flume[name].meta
      sv.since.once(function build (upto) {
        log.since.once(function (since) {
          if(upto > since) {
            sv.destroy(function () { build(-1) })
          } else {
            var opts = {gt: upto, live: true, seqs: true, values: true}
            if (upto == -1)
              opts.cache = false
            pull(
              log.stream(opts),
              Looper,
              sv.createSink(function (err) {
                if(!flume.closed) {
                  if(err)
                    console.error(explain(err, 'view stream error'))
                  sv.since.once(build)
                }
              })
            )
          }
        })
      })

      return flume
    },
    rebuild: function (cb) {
      return cont.para(map(views, function (sv) {
        return function (cb) {
          sv.destroy(function (err) {
            if(err) return cb(err)
            //destroy should close the sink stream,
            //which will restart the write.
            var rm = sv.since(function (v) {
              if(v === log.since.value) {
                rm()
                cb()
              }
            })
          })
        }
      }))
      (function (err) {
        if(err) cb(err) //hopefully never happens

        //then restream each streamview, and callback when it's uptodate with the main log.
      })
    },
    close: function (cb) {
      if(flume.closed) return cb()
      flume.closed = true
      cont.para(map(views, function (sv, k) {
        return function (cb) {
          if(sv.close) sv.close(cb)
          else cb()
        }
      })) (cb)

    }
  }

  // XXX: doesn't seem very DRY, but it's more performant to check this now
  // rather than waiting until runtime to figure out whether `mapper` exists
  if (mapper) {
    flume.get = function (seq, cb) {
      log.since.once(() => {
        log.get(seq, (err, value) => {
          mapper(value, (res) => {
            cb(err, res)
          })
        })
      })
    }
    flume.stream = function (opts) {
      return PullCont((cb) => {
        log.since.once(() => {
          cb(null, pull(
            log.stream(opts),
            mapStream(opts),
            Looper
          ))
        })
      })
    }
  } else {
    flume.get = function (seq, cb) {
      log.since.once(function () {
        log.get(seq, cb)
      })
    }
    flume.stream = function (opts) {
      return PullCont(function (cb) {
        log.since.once(function () {
          cb(null, pull(log.stream(opts), Looper))
        })
      })
    }
  }
  return flume
}

