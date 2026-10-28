window.__ModuleLoader__.load({
	id: "kolid-dsh-bind",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * kolid-dsh-bind — 把工作台选定的那一个目录钉成 dsh 的工作区。
		 *
		 * 分工:工作台页面(iframe 的宿主)知道当前 cud 的目录,后端把它算成绝对路径;iframe 是跨域的,
		 * 宿主摸不到这里的 DOM,能说的只有 postMessage —— 我们在挂好监听后举一次手(READY),宿主
		 * 收到就把当前目录发过来,之后每次换 cud 再发一次。这个插件收下它:交给 Workspace Controller
		 * 建成/取回同一个工作区(按路径幂等),再把主视图切过去。
		 *
		 * 切法要讲究:直接 openWorkspace 每次都会**新建一条会话**,换几次 cud 就留下一串空会话。所以
		 * 先看这个工作区里有没有会话 —— 有就接着最近的那条,一条都没有才让 dsh 开新的。
		 *
		 * 界面这边只做减法:工作区那颗按钮改成只读标签(去掉箭头),「添加工作区」的入口藏掉,连它
		 * 那颗快捷键也吞掉 —— 按钮藏了但 Ctrl+Alt+O 还能把目录流程叫出来,那就等于没藏。为什么
		 * 不用 dsh 的 directory-picker 关掉整个挑选流程 —— ui-workspace 的 inject 里写着
		 * `remote.directoryPicker`,把 picker 拆了它整块都起不来(见 client.js 的 inject 与 apply)。
		 * 所以挑目录的能力留着,只把入口从画面上拿掉。
		 *
		 * 会话搜索同样藏:它在收起态的图标栏里占一格、展开态在会话表头里占一段,两处都是**容器**
		 * 本身可点(表头那段是整块 div 的 onClick 展开搜索框),所以藏的必须是容器而不是那颗图标;
		 * 再加 Ctrl+K 也一起吞 —— 理由与添加工作区相同:入口没了、键位还在,等于没藏。
		 *
		 * 侧边栏里别的工作区也藏:钉住的是哪个目录,就只留那一组和它的会话 —— 这份页面只服务
		 * 当前这个 cud,列出别的目录只会让人误点进去。
		 */
		const inject = ["locale", "workspaces", "sessions", "shortcuts", "uiWorkspace"];

		/** 宿主只可能是工作台页面:127.0.0.1 上的 8700..8799(每次跑取一个)。 */
		const HOST_ORIGIN = /^http:\/\/127\.0\.0\.1:87\d\d$/;
		const BIND = "kolid-dsh-bind";
		const READY = "kolid-dsh-bind-ready";

		/** 类名带了每次构建都会变的哈希前缀(`pXSMma_workspace`),只按局部名匹配才跟得上重建。 */
		const lockCss = ({ add, search }) => {
			const esc = (label) => String(label).replace(/"/g, '\\"');
			const hideButton = (label) => `button[aria-label="${esc(label)}"]{display:none!important}`;
			const rules = [
				"button[class*=\"_workspace\"]{pointer-events:none!important;cursor:default!important}",
				"button[class*=\"_workspace\"] [class*=\"_chevron\"]{display:none!important}",
				// 展开态:会话表头里"图标 + 输入框"那一整段。
				"[class*=\"_searchSlot\"]{display:none!important}"
			];
			if (add) rules.push(hideButton(add));
			if (search) {
				rules.push(hideButton(search));
				// 收起态:图标栏里包着那颗搜索图标的格子。它自己可点(onClick 展开搜索),所以藏的是
				// 这一格 —— 只藏里面的 button 会留下一个能点出搜索框的空位。`> ` 限定直接子节点,
				// 免得把外面那些同样是搜索的外层容器也一并吃掉。
				rules.push(`div:has(> button[aria-label="${esc(search)}"]){display:none!important}`);
			}
			return rules.join("\n");
		};

		/**
		 * 侧边栏只留钉住的那个目录:别的目录(以及没归到任何工作区的会话)藏掉。
		 * 分组视图按小节藏 —— 每个工作区是一格 `_groupSection`,首行 `workspace:<id>`;
		 * 平铺视图没有小节,只能按会话 id 白名单把自家的行显回来。
		 */
		const groupCss = (workspaceId, sessionIds) => {
			if (workspaceId === "") return "";
			const rules = [`[class*="_groupSection"]:not(:has([data-row-key="workspace:${workspaceId}"])){display:none!important}`];
			rules.push(`[class*="_flatList"] [data-row-key^="session:"]{display:none!important}`);
			for (const sessionId of sessionIds) rules.push(`[class*="_flatList"] [data-row-key="session:${sessionId}"]{display:flex!important}`);
			return rules.join("\n");
		};

		const log = (what, why) => console.warn("kolid-dsh-bind: " + what, why === undefined ? "" : why);

		function apply(ctx) {
			const style = document.createElement("style");
			style.id = "kolid-dsh-bind";
			// 两条都是 aria-label:界面上没有可见文字可抓,按钮又会被翻译改写,只能按读屏名匹配。
			const label = (key, what) => {
				try {
					return ctx.locale.bind("workspace")(key);
				} catch (error) {
					log(what + " label unavailable", error);
					return "";
				}
			};
			style.textContent = lockCss({
				add: label("workspace.add", "add-workspace"),
				search: label("search.sessions.aria", "search")
			});
			document.head.appendChild(style);

			/** 宿主最近一次点名的目录;空 = 还没人说过话。 */
			let want = "";
			/** 串行队列:换目录的两步(建工作区 / 切会话)不能交错跑。 */
			let queue = Promise.resolve();

			const groupStyle = document.createElement("style");
			groupStyle.id = "kolid-dsh-bind-groups";
			document.head.appendChild(groupStyle);
			/** 钉住的那个工作区;目录刚建时可能还没落到列表里,那就不藏任何东西。 */
			const ourWorkspace = () => {
				if (!want) return void 0;
				return ctx.workspaces.list.getSnapshot().items.find((row) => row.path === want);
			};
			let groupTimer = 0;
			const paintGroups = () => {
				groupTimer = 0;
				const workspace = ourWorkspace();
				const css = workspace === void 0 ? "" : groupCss(workspace.workspaceId, workspace.sessionIds);
				if (groupStyle.textContent !== css) groupStyle.textContent = css;
			};
			// 会话表与工作区表都会在背后动(切会话、开新会话、归档),等这一轮渲染落定再改。
			const scheduleGroups = () => {
				if (groupTimer === 0) groupTimer = setTimeout(paintGroups, 0);
			};
			const unwatch = [];
			for (const [store, what] of [[ctx.workspaces.list, "workspace list"], [ctx.sessions.list, "session list"]]) {
				try {
					if (store && typeof store.subscribe === "function") unwatch.push(store.subscribe(scheduleGroups));
				} catch (error) {
					log(what + " watch failed", error);
				}
			}

			const selection = () => {
				const reference = ctx.uiWorkspace && ctx.uiWorkspace.mainReference;
				if (reference && reference.sessionId) return reference.sessionId;
				// mainReference 是给 `open*` 记账用的;开机那一刻它可能还没立起来,退到 dsh 自己的存档键。
				try {
					return JSON.parse(localStorage.getItem("dsh.sessions.current") || "{}").sessionId;
				} catch (error) {
					return void 0;
				}
			};
			const workspaceOf = (sessionId) => {
				if (!sessionId) return void 0;
				return ctx.workspaces.list.getSnapshot().items.find((w) => w.sessionIds.indexOf(sessionId) >= 0);
			};
			/** 这个工作区里最近动过的那条会话(归档的不算)。 */
			const newestSession = (workspaceId, archived) => {
				const row = ctx.workspaces.list.getSnapshot().items.find((w) => w.workspaceId === workspaceId);
				const list = ctx.sessions.list.getSnapshot();
				let pick;
				let at = -Infinity;
				for (const sessionId of row ? row.sessionIds : []) {
					if (archived.indexOf(sessionId) >= 0) continue;
					const summary = list.byId[sessionId];
					if (summary === void 0) continue;
					const stamp = summary.updatedAt || 0;
					if (stamp > at) {
						at = stamp;
						pick = sessionId;
					}
				}
				return pick;
			};

			/** 服务级守卫:hero 按钮、侧栏工作区行、快捷键最后都落到这几个方法上 —— 只在这拦住才算真锁。 */
			const patched = [];
			const lockNavigation = () => {
				const allowed = (workspaceId) => {
					if (!want) return true; // 还没钉过目录:不拦,交回 dsh 自己的行为
					const row = ctx.workspaces.list.getSnapshot().items.find((w) => w.workspaceId === workspaceId);
					return row === void 0 || row.path === want;
				};
				const wrap = (name, guard) => {
					const original = ctx.uiWorkspace && ctx.uiWorkspace[name];
					if (typeof original !== "function") return;
					try {
						ctx.uiWorkspace[name] = function (...args) {
							let go = true;
							try {
								go = guard(...args);
							} catch (error) {
								log(name + " guard failed", error);
							}
							if (!go) return void 0;
							return original.apply(this, args);
						};
						patched.push([name, original]);
					} catch (error) {
						log(name + " lock failed", error);
					}
				};
				wrap("openWorkspace", (workspaceId) => allowed(workspaceId));
				wrap("connectWorkspace", (workspaceId) => allowed(workspaceId));
				wrap("startSession", (workspaceId) => workspaceId === void 0 || allowed(workspaceId));
				wrap("openSession", (target) => {
					const sessionId = typeof target === "string" ? target : target && (target.sessionId || target.id);
					const row = workspaceOf(sessionId);
					return row === void 0 || allowed(row.workspaceId);
				});
			};
			lockNavigation();

			/** 键位也是入口:`workspace.add` 的 web 默认是 Ctrl+Alt+O,按下去就把目录流程叫出来了;
			 *  `session.search` 是 Ctrl+K,按下去会话表头就展开成搜索框。键位可以被用户改,所以每次
			 *  按键都读当前生效的那一条,不写死 KeyO/KeyK。 */
			const SWALLOW = ["workspace.add", "session.search"];
			const chords = (id) => {
				try {
					const row = ctx.shortcuts.catalog.getSnapshot().find((entry) => entry.id === id);
					return row && row.binding ? [row.binding] : [];
				} catch (error) {
					log("shortcut catalog unavailable", error);
					return [];
				}
			};
			const onKey = (event) => {
				if (event.defaultPrevented) return;
				const held = { control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
				const down = Object.keys(held).filter((name) => held[name]);
				for (const id of SWALLOW) {
					for (const binding of chords(id)) {
						const wanted = binding.modifiers || [];
						const sameMods = wanted.length === down.length && wanted.every((name) => held[name] === true);
						if (!sameMods || (event.code !== binding.code && event.code !== binding.secondCode)) continue;
						event.preventDefault();
						event.stopImmediatePropagation();
						return;
					}
				}
			};
			window.addEventListener("keydown", onKey, true);

			const createWorkspace = async (path) => {
				// create 按路径幂等(已存在就取回同一行),失败是 reject —— 抛的 WorkspaceCreateError
				// 带 rpcError(workspace/invalid-path、name-conflict…)。开机那几秒连接可能还没接线,
				// 所以失败就再来一次,直到超时才把最后一个错误抛给 bind 的日志。
				let last;
				for (let attempt = 0; attempt < 20; attempt++) {
					try {
						return await ctx.workspaces.create({ path });
					} catch (error) {
						last = error;
						await new Promise((resolve) => setTimeout(resolve, 700));
					}
				}
				const code = last && last.rpcError && last.rpcError.code;
				throw new Error("workspace create failed" + (code ? " [" + code + "]" : "") + ": " + (last && last.message));
			};

			/** 两份列表都到齐(sessions 的 phase 是开机后才 'ready')—— 早读会把"还没到"当成"没有"。 */
			const waitLists = async (ms) => {
				const until = Date.now() + ms;
				const ready = () => ctx.workspaces.list.getSnapshot().phase === "ready"
					&& ctx.sessions.list.getSnapshot().phase === "ready";
				while (!ready() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200));
			};

			const moveTo = async (path) => {
				const workspace = await createWorkspace(path);
				if (!workspace) return;
				const here = workspaceOf(selection());
				if (here !== void 0 && here.workspaceId === workspace.workspaceId) return;
				// 列表到齐再挑会话:没到齐时 byId 是空的,会白开一条新会话。
				await waitLists(12000);
				const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds || [];
				const pick = newestSession(workspace.workspaceId, archived);
				if (pick !== void 0) {
					try {
						ctx.uiWorkspace.openSession(pick);
						return;
					} catch (error) {
						log("openSession failed", error);
					}
				}
				await ctx.uiWorkspace.openWorkspace(workspace.workspaceId);
			};

			const bind = (path) => {
				want = typeof path === "string" ? path : "";
				if (want === "") return;
				scheduleGroups();
				const target = want;
				const once = () => moveTo(target).catch((error) => log("bind failed", error));
				queue = queue.then(once);
				// 开机的 restoreSelection 是异步的(它还要去 Host 取会话),可能落在我们后面把主视图
				// 又摆回上次那条。等它落定再核一次:不在目标工作区就再切一次。
				queue = queue.then(() => new Promise((resolve) => setTimeout(resolve, 1500))).then(() => {
					if (want !== target) return;
					const workspace = ctx.workspaces.list.getSnapshot().items.find((w) => w.path === target);
					if (workspace === void 0) return;
					const here = workspaceOf(selection());
					if (here !== void 0 && here.workspaceId === workspace.workspaceId) return;
					return once();
				}).catch((error) => log("bind settle failed", error));
			};

			const onMessage = (event) => {
				if (!HOST_ORIGIN.test(event.origin)) return;
				const data = event.data;
				if (data === null || typeof data !== "object" || data.type !== BIND) return;
				bind(data.path);
			};
			window.addEventListener("message", onMessage);

			// 开机那一次不靠地址栏:token 换 cookie 的那一跳是 303 `location: ./`,查询串会被丢掉。
			// 所以只等宿主的 postMessage —— 它在我们举手(READY)时、以及 iframe 每次 load 后都会发。

			// 反过来举手:我们的监听可能比宿主的晚挂(iframe 先加载完),它一听这句就补发当前目录。
			try {
				if (window.parent !== window) window.parent.postMessage({ type: READY }, "*");
			} catch (error) {
				log("ready announce failed", error);
			}

			ctx.effect(() => () => {
				window.removeEventListener("message", onMessage);
				window.removeEventListener("keydown", onKey, true);
				if (groupTimer !== 0) clearTimeout(groupTimer);
				for (const stop of unwatch) {
					try {
						stop();
					} catch (error) {
						log("watcher release failed", error);
					}
				}
				groupStyle.remove();
				for (const [name, original] of patched) {
					try {
						ctx.uiWorkspace[name] = original;
					} catch (error) {
						log(name + " unlock failed", error);
					}
				}
				style.remove();
			}, "kolid-dsh-bind: workspace lock");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
