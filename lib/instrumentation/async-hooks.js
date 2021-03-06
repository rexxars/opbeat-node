'use strict'

var util = require('util')
var shimmer = require('./shimmer')
var isNative = require('is-native')
var wrap = shimmer.wrap
var massWrap = shimmer.massWrap

module.exports = function (ins) {
  var net = require('net')

  // a polyfill in our polyfill etc so forth -- taken from node master on 2013/10/30
  if (!net._normalizeConnectArgs) {
    net._normalizeConnectArgs = function (args) {
      var options = {}

      function toNumber (x) { return (x = Number(x)) >= 0 ? x : false }

      if (typeof args[0] === 'object' && args[0] !== null) {
        // connect(options, [cb])
        options = args[0]
      } else if (typeof args[0] === 'string' && toNumber(args[0]) === false) {
        // connect(path, [cb])
        options.path = args[0]
      } else {
        // connect(port, [host], [cb])
        options.port = args[0]
        if (typeof args[1] === 'string') {
          options.host = args[1]
        }
      }

      var cb = args[args.length - 1]
      return typeof cb === 'function' ? [options, cb] : [options]
    }
  }

  wrap(net.Server.prototype, '_listen2', function (original) {
    return function () {
      this.on('connection', function (socket) {
        if (socket._handle) {
          socket._handle.onread = ins.bindFunction(socket._handle.onread)
        }
      })

      try {
        return original.apply(this, arguments)
      } finally {
        // the handle will only not be set in cases where there has been an error
        if (this._handle && this._handle.onconnection) {
          this._handle.onconnection = ins.bindFunction(this._handle.onconnection)
        }
      }
    }
  })

  function patchOnRead (ctx) {
    if (ctx && ctx._handle) {
      var handle = ctx._handle
      if (!handle._obOriginalOnread) {
        handle._obOriginalOnread = handle.onread
      }
      handle.onread = ins.bindFunction(handle._obOriginalOnread)
    }
  }

  wrap(net.Socket.prototype, 'connect', function (original) {
    return function () {
      var args = net._normalizeConnectArgs(arguments)
      if (args[1]) args[1] = ins.bindFunction(args[1])
      var result = original.apply(this, args)
      patchOnRead(this)
      return result
    }
  })

  var http = require('http')

  // NOTE: A rewrite occurred in 0.11 that changed the addRequest signature
  // from (req, host, port, localAddress) to (req, options)
  // Here, I use the longer signature to maintain 0.10 support, even though
  // the rest of the arguments aren't actually used
  wrap(http.Agent.prototype, 'addRequest', function (original) {
    return function (req) {
      var onSocket = req.onSocket
      req.onSocket = ins.bindFunction(function (socket) {
        patchOnRead(socket)
        return onSocket.apply(this, arguments)
      })
      return original.apply(this, arguments)
    }
  })

  var childProcess = require('child_process')

  function wrapChildProcess (child) {
    if (Array.isArray(child.stdio)) {
      child.stdio.forEach(function (socket) {
        if (socket && socket._handle) {
          socket._handle.onread = ins.bindFunction(socket._handle.onread)
          wrap(socket._handle, 'close', activatorFirst)
        }
      })
    }

    if (child._handle) {
      child._handle.onexit = ins.bindFunction(child._handle.onexit)
    }
  }

  // iojs v2.0.0+
  if (childProcess.ChildProcess) {
    wrap(childProcess.ChildProcess.prototype, 'spawn', function (original) {
      return function () {
        var result = original.apply(this, arguments)
        wrapChildProcess(this)
        return result
      }
    })
  } else {
    massWrap(childProcess, [
      'execFile', // exec is implemented in terms of execFile
      'fork',
      'spawn'
    ], function (original) {
      return function () {
        var result = original.apply(this, arguments)
        wrapChildProcess(result)
        return result
      }
    })
  }

  // need unwrapped nextTick for use within < 0.9 async error handling
  if (!process._fatalException) {
    process._originalNextTick = process.nextTick
  }

  var processors = []
  if (process._nextDomainTick) processors.push('_nextDomainTick')
  if (process._tickDomainCallback) processors.push('_tickDomainCallback')

  massWrap(
    process,
    processors,
    activator
  )
  wrap(process, 'nextTick', activatorFirst)

  var asynchronizers = [
    'setTimeout',
    'setInterval'
  ]
  if (global.setImmediate) asynchronizers.push('setImmediate')

  var timers = require('timers')
  var patchGlobalTimers = global.setTimeout === timers.setTimeout

  massWrap(
    timers,
    asynchronizers,
    activatorFirst
  )

  if (patchGlobalTimers) {
    massWrap(
      global,
      asynchronizers,
      activatorFirst
    )
  }

  var dns = require('dns')
  massWrap(
    dns,
    [
      'lookup',
      'resolve',
      'resolve4',
      'resolve6',
      'resolveCname',
      'resolveMx',
      'resolveNs',
      'resolveTxt',
      'resolveSrv',
      'reverse'
    ],
    activator
  )

  if (dns.resolveNaptr) wrap(dns, 'resolveNaptr', activator)

  var fs = require('fs')
  massWrap(
    fs,
    [
      'watch',
      'rename',
      'truncate',
      'chown',
      'fchown',
      'chmod',
      'fchmod',
      'stat',
      'lstat',
      'fstat',
      'link',
      'symlink',
      'readlink',
      'realpath',
      'unlink',
      'rmdir',
      'mkdir',
      'readdir',
      'close',
      'open',
      'utimes',
      'futimes',
      'fsync',
      'write',
      'read',
      'readFile',
      'writeFile',
      'appendFile',
      'watchFile',
      'unwatchFile',
      'exists'
    ],
    activator
  )

  // only wrap lchown and lchmod on systems that have them.
  if (fs.lchown) wrap(fs, 'lchown', activator)
  if (fs.lchmod) wrap(fs, 'lchmod', activator)

  // only wrap ftruncate in versions of node that have it
  if (fs.ftruncate) wrap(fs, 'ftruncate', activator)

  // Wrap zlib streams
  var zlib
  try { zlib = require('zlib') } catch (err) { }
  if (zlib && zlib.Deflate && zlib.Deflate.prototype) {
    var proto = Object.getPrototypeOf(zlib.Deflate.prototype)
    if (proto._transform) {
      // streams2
      wrap(proto, '_transform', activator)
    } else if (proto.write && proto.flush && proto.end) {
      // plain ol' streams
      massWrap(
        proto,
        [
          'write',
          'flush',
          'end'
        ],
        activator
      )
    }
  }

  // Wrap Crypto
  var crypto
  try { crypto = require('crypto') } catch (err) { }
  if (crypto) {
    massWrap(
      crypto,
      [
        'pbkdf2',
        'randomBytes',
        'pseudoRandomBytes'
      ],
      activator
    )
  }

  var instrumentPromise = isNative(global.Promise)

  // In case it's a non-native Promise, but bind have been used so it
  // looks native. There's still a potential false positive if the
  // non-native Promise library have a `name` property set to "Promise".
  // But worst case, the non-native Promise library will be instrumented
  // twice.
  instrumentPromise = instrumentPromise && global.Promise.name === 'Promise'

  /*
   * Native promises use the microtask queue to make all callbacks run
   * asynchronously to avoid Zalgo issues. Since the microtask queue is not
   * exposed externally, promises need to be modified in a fairly invasive and
   * complex way.
   *
   * The async boundary in promises that must be patched is between the
   * fulfillment of the promise and the execution of any callback that is waiting
   * for that fulfillment to happen. This means that we need to trigger a create
   * when accept or reject is called and trigger before, after and error handlers
   * around the callback execution. There may be multiple callbacks for each
   * fulfilled promise, so handlers will behave similar to setInterval where
   * there may be multiple before after and error calls for each create call.
   *
   * async-listener monkeypatching has one basic entry point: `wrapCallback`.
   * `wrapCallback` should be called when create should be triggered and be
   * passed a function to wrap, which will execute the body of the async work.
   * The accept and reject calls can be modified fairly easily to call
   * `wrapCallback`, but at the time of accept and reject all the work to be done
   * on fulfillment may not be defined, since a call to then, chain or fetch can
   * be made even after the promise has been fulfilled. To get around this, we
   * create a placeholder function which will call a function passed into it,
   * since the call to the main work is being made from within the wrapped
   * function, async-listener will work correctly.
   *
   * There is another complication with monkeypatching Promises. Calls to then,
   * chain and catch each create new Promises that are fulfilled internally in
   * different ways depending on the return value of the callback. When the
   * callback return a Promise, the new Promise is resolved asynchronously after
   * the returned Promise has been also been resolved. When something other than
   * a promise is resolved the accept call for the new Promise is put in the
   * microtask queue and asynchronously resolved.
   *
   * Then must be wrapped so that its returned promise has a wrapper that can be
   * used to invoke further continuations. This wrapper cannot be created until
   * after the callback has run, since the callback may return either a promise
   * or another value. Fortunately we already have a wrapper function around the
   * callback we can use (the wrapper created by accept or reject).
   *
   * By adding an additional argument to this wrapper, we can pass in the
   * returned promise so it can have its own wrapper appended. the wrapper
   * function can the call the callback, and take action based on the return
   * value. If a promise is returned, the new Promise can proxy the returned
   * Promise's wrapper (this wrapper may not exist yet, but will by the time the
   * wrapper needs to be invoked). Otherwise, a new wrapper can be create the
   * same way as in accept and reject. Since this wrapper is created
   * synchronously within another wrapper, it will properly appear as a
   * continuation from within the callback.
   */

  if (instrumentPromise) {
    wrapPromise()
  }

  function wrapPromise () {
    var Promise = global.Promise

    function wrappedPromise (executor) {
      if (!(this instanceof wrappedPromise)) {
        return Promise(executor)
      }

      if (typeof executor !== 'function') {
        return new Promise(executor)
      }

      var context, args
      var promise = new Promise(wrappedExecutor)
      promise.__proto__ = wrappedPromise.prototype // eslint-disable-line no-proto

      try {
        executor.apply(context, args)
      } catch (err) {
        args[1](err)
      }

      return promise

      function wrappedExecutor (accept, reject) {
        context = this
        args = [wrappedAccept, wrappedReject]

        // These wrappers create a function that can be passed a function and an argument to
        // call as a continuation from the accept or reject.
        function wrappedAccept (val) {
          ensureAslWrapper(promise, false)
          return accept(val)
        }

        function wrappedReject (val) {
          ensureAslWrapper(promise, false)
          return reject(val)
        }
      }
    }

    util.inherits(wrappedPromise, Promise)

    wrap(Promise.prototype, 'then', wrapThen)
    if (Promise.prototype.chain) {
      wrap(Promise.prototype, 'chain', wrapThen)
    }

    var PromiseMethods = ['accept', 'all', 'defer', 'race', 'reject', 'resolve']

    PromiseMethods.forEach(function (key) {
      wrappedPromise[key] = Promise[key]
    })

    global.Promise = wrappedPromise

    function ensureAslWrapper (promise, overwrite) {
      if (!promise.__asl_wrapper || overwrite) {
        promise.__asl_wrapper = ins.bindFunction(propagateAslWrapper)
      }
    }

    function propagateAslWrapper (ctx, fn, result, next) {
      var nextResult
      try {
        nextResult = fn.call(ctx, result)
        return {returnVal: nextResult, error: false}
      } catch (err) {
        return {errorVal: err, error: true}
      } finally {
        // Wrap any resulting futures as continuations.
        if (nextResult instanceof Promise) {
          next.__asl_wrapper = function proxyWrapper () {
            var aslWrapper = nextResult.__asl_wrapper || propagateAslWrapper
            return aslWrapper.apply(this, arguments)
          }
        } else {
          ensureAslWrapper(next, true)
        }
      }
    }

    function wrapThen (original) {
      return function wrappedThen () {
        var promise = this
        var next = original.apply(promise, Array.prototype.map.call(arguments, bind))

        next.__asl_wrapper = function proxyWrapper (ctx, fn, val, last) {
          if (promise.__asl_wrapper) {
            promise.__asl_wrapper(ctx, function () {}, null, next)
            return next.__asl_wrapper(ctx, fn, val, last)
          }
          return propagateAslWrapper(ctx, fn, val, last)
        }

        return next

        // wrap callbacks (success, error) so that the callbacks will be called as a
        // continuations of the accept or reject call using the __asl_wrapper created above.
        function bind (fn) {
          if (typeof fn !== 'function') return fn
          return function (val) {
            var result = (promise.__asl_wrapper || propagateAslWrapper)(this, fn, val, next)
            if (result.error) {
              throw result.errorVal
            } else {
              return result.returnVal
            }
          }
        }
      }
    }
  }

  // Shim activator for functions that have callback last
  function activator (fn) {
    var fallback = function () {
      var args
      var cbIdx = arguments.length - 1
      if (typeof arguments[cbIdx] === 'function') {
        args = Array(arguments.length)
        for (var i = 0; i < arguments.length - 1; i++) {
          args[i] = arguments[i]
        }
        args[cbIdx] = ins.bindFunction(arguments[cbIdx])
      }
      return fn.apply(this, args || arguments)
    }
    // Preserve function length for small arg count functions.
    switch (fn.length) {
      case 1:
        return function (cb) {
          if (arguments.length !== 1) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb)
        }
      case 2:
        return function (a, cb) {
          if (arguments.length !== 2) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, a, cb)
        }
      case 3:
        return function (a, b, cb) {
          if (arguments.length !== 3) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, a, b, cb)
        }
      case 4:
        return function (a, b, c, cb) {
          if (arguments.length !== 4) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, a, b, c, cb)
        }
      case 5:
        return function (a, b, c, d, cb) {
          if (arguments.length !== 5) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, a, b, c, d, cb)
        }
      case 6:
        return function (a, b, c, d, e, cb) {
          if (arguments.length !== 6) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, a, b, c, d, e, cb)
        }
      default:
        return fallback
    }
  }

  // Shim activator for functions that have callback first
  function activatorFirst (fn) {
    var fallback = function () {
      var args
      if (typeof arguments[0] === 'function') {
        args = Array(arguments.length)
        args[0] = ins.bindFunction(arguments[0])
        for (var i = 1; i < arguments.length; i++) {
          args[i] = arguments[i]
        }
      }
      return fn.apply(this, args || arguments)
    }
    // Preserve function length for small arg count functions.
    switch (fn.length) {
      case 1:
        return function (cb) {
          if (arguments.length !== 1) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb)
        }
      case 2:
        return function (cb, a) {
          if (arguments.length !== 2) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb, a)
        }
      case 3:
        return function (cb, a, b) {
          if (arguments.length !== 3) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb, a, b)
        }
      case 4:
        return function (cb, a, b, c) {
          if (arguments.length !== 4) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb, a, b, c)
        }
      case 5:
        return function (cb, a, b, c, d) {
          if (arguments.length !== 5) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb, a, b, c, d)
        }
      case 6:
        return function (cb, a, b, c, d, e) {
          if (arguments.length !== 6) return fallback.apply(this, arguments)
          if (typeof cb === 'function') cb = ins.bindFunction(cb)
          return fn.call(this, cb, a, b, c, d, e)
        }
      default:
        return fallback
    }
  }
}
