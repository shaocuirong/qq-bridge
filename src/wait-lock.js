// 会话级「长轮询等待」互斥锁。
//
// 为什么单独抽出来：这把锁的**释放时机**踩过一个很隐蔽的 Node 语义坑，
// 而它一旦出错，表现是「整个会话被锁死」而不是小毛病：
//
//   Node ≥ 16 的 `http.IncomingMessage` 在「请求体读完」时就发 `'close'`，
//   它**不代表客户端断开**（客户端断开只有 `res` 会告诉你）。
//   桥接是在 `await readBody()` **之后**才注册 `req.on('close', …)` 的，
//   那时事件早已发过 —— 监听器等于死代码。于是当客户端中途放弃这次长轮询
//   （MCP 侧 `AbortSignal.timeout`、DSH 中断、控制台刷新等），锁不会释放，
//   要等 handler 自己跑完整个预算；这段时间里同一会话的每次等待都返回
//   429「该会话已有一个等待中的 qq_wait_for_messages」，而 `qq_mark_read` /
//   `qq_set_wake_config` 又因为没有沉睡前观察被拒 —— AI 既不能观察也不能收尾。
//
// 因此本模块的契约是：
//   1. `acquire()` 拿到锁时必须 `bind(res)`，把释放挂在 **res** 的 `'close'` 上；
//   2. `hold.aborted` 供等待循环提前退出，别让已经没人要的等待继续空转；
//   3. 记下 `expectedReleaseAt`，好让 429 的调用方知道「还要等多久」而不是死循环重试；
//   4. `leaseMs` 只是兜底：handler 抛异常等异常路径没释放时，租约到期允许下一个等待接管。

export function createWaitLock({ leaseMs = 15 * 60 * 1000 } = {}) {
  /** key -> { at, aborted, released, expectedReleaseAt } */
  const held = new Map();

  /** 过期（残留）就顺手清掉，返回仍然有效的记录。 */
  function live(key) {
    const rec = held.get(key);
    if (!rec) return null;
    if (Date.now() - rec.at >= leaseMs) {
      held.delete(key);
      return null;
    }
    return rec;
  }

  /** 查看锁的占用情况（给 429 兜底与 /api/status 用），无占用返回 null。 */
  function heldInfo(key) {
    const rec = live(key);
    if (!rec) return null;
    const heldForMs = Date.now() - rec.at;
    return {
      key,
      heldForMs,
      // 没写 expectedReleaseAt 时用租约上限兜底，至少给调用方一个上界。
      releaseInMs: Math.max(0, (rec.expectedReleaseAt || rec.at + leaseMs) - Date.now()),
      leaseLeftMs: Math.max(0, leaseMs - heldForMs)
    };
  }

  /**
   * 尝试拿到 key 的等待锁；已被占用（且未过租约）返回 null。
   * 拿到后务必 `bind(res)`，别再自己监听 `req` 的 close。
   */
  function acquire(key) {
    if (live(key)) return null;
    const rec = {
      at: Date.now(),
      aborted: false,
      released: false,
      expectedReleaseAt: 0
    };
    held.set(key, rec);

    /** 只删自己这一把：中途可能已被会话退役清掉、或被新租约接管。 */
    function release() {
      if (held.get(key) === rec) held.delete(key);
      rec.released = true;
    }

    /**
     * 把「锁的生命周期」绑到这次 HTTP 响应上：
     * 客户端断开（或响应正常结束）时立刻释放，并置 aborted 让等待循环尽快退出。
     * @param {import('node:http').ServerResponse} res
     * @param {() => void} [onGone] 额外回调（桥接用它把局部 aborted 变量置位）
     */
    function bind(res, onGone) {
      const gone = () => {
        rec.aborted = true;
        if (typeof onGone === 'function') {
          try { onGone(); } catch { /* 回调不能影响释放 */ }
        }
        release();
      };
      if (res && typeof res.on === 'function') {
        res.on('close', gone);
        res.on('error', gone);
      }
      // 绑定前客户端就已经消失了（极端情况）：直接判定为已中断。
      if (res && (res.destroyed || res.writableEnded)) gone();
      return rec;
    }

    rec.bind = bind;
    rec.release = release;
    return rec;
  }

  /** 强制清掉某个会话的锁（会话退役 / 重命名 / 重置工作区）。 */
  function release(key) {
    held.delete(key);
  }

  function clear() {
    held.clear();
  }

  function list() {
    const out = [];
    for (const key of [...held.keys()]) {
      const info = heldInfo(key);
      if (info) out.push({ key, heldForMs: info.heldForMs, releaseInMs: info.releaseInMs });
    }
    return out;
  }

  return { acquire, release, clear, heldInfo, list, leaseMs };
}
