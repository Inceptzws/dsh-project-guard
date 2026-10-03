/**
 * Impact analysis for every confirmation the guard raises.
 *
 * A confirmation that only asks "allow?" makes the user guess. This module
 * answers the question they actually have — *what goes wrong if I say yes* —
 * with a deterministic, rule-driven assessment: an impact level, the concrete
 * adverse outcome, and whether it can be undone.
 *
 * The analysis is deliberately conservative and never model-generated: it is a
 * table lookup on the verdict code, refined per program for system commands.
 *
 * @module dsh-project-guard/lib/impact
 */

/** Localized labels for the four impact levels. */
export const LEVEL_LABELS = {
  en: { high: 'high', medium: 'medium', low: 'low', unknown: 'unknown' },
  zh: { high: '高', medium: '中', low: '低', unknown: '未知' }
};

/** Impact of one verdict category, used when no program-specific entry matches. */
const CODE_IMPACTS = {
  // ---- machine- or session-destroying actions (denied by default) ----------
  FORK_BOMB: {
    level: 'high',
    zh: '瞬间创建大量进程并耗尽内存，整机会卡死，其他程序全部失去响应，通常只能强制重启。',
    en: 'Sprays processes until memory is exhausted; the whole machine freezes, every other program stops responding, and a hard restart is usually the only way out.'
  },
  ROOT_DELETE: {
    level: 'high',
    zh: '会从文件系统根目录递归删除，系统文件与应用数据被不可恢复地清除，机器可能再也无法正常启动。',
    en: 'Recursively deletes from the filesystem root, irreversibly removing system files and application data; the machine may never boot normally again.'
  },
  HOME_DELETE: {
    level: 'high',
    zh: '会删除整个用户目录，个人文件、其他项目的代码与本地配置全部不可恢复。',
    en: 'Deletes the entire home directory: personal files, every other project and all local configuration, with no recovery.'
  },
  FORMAT: {
    level: 'high',
    zh: '会格式化或重新分区磁盘，该卷上的数据永久丢失，系统可能无法启动。',
    en: 'Formats or repartitions a disk. Data on that volume is permanently lost and the system may become unbootable.'
  },
  RAW_DISK_WRITE: {
    level: 'high',
    zh: '会向块设备直接写入原始数据，绕过文件系统，磁盘内容和引导区都可能被摧毁。',
    en: 'Writes raw data straight to a block device, bypassing the filesystem; both the volume contents and the boot sector can be destroyed.'
  },
  DISK_ERASE: {
    level: 'high',
    zh: '会擦除磁盘或宗卷，其中的数据无法恢复。',
    en: 'Erases a disk or volume; the data on it cannot be recovered.'
  },
  POWER_OFF: {
    level: 'high',
    zh: '会关机或重启，所有程序立即终止、未保存的工作丢失，当前这个会话也随之结束。',
    en: 'Powers the machine off or reboots it. Every program stops immediately, unsaved work is lost, and this session ends with it.'
  },
  NETWORK_OFF: {
    level: 'high',
    zh: '会关闭 Wi-Fi，本机与外部的连接全部断开——包括承载本次对话的模型服务，会话会直接失联，且需要你手动重新开启网络才能恢复。',
    en: 'Turns Wi-Fi off. The machine loses every outside connection, including the model service carrying this conversation: the session is cut off and only you can bring the network back.'
  },
  INTERFACE_DOWN: {
    level: 'high',
    zh: '会把网络接口或防火墙拉下来，等效于断网，可能让当前会话和所有联网程序失联。',
    en: 'Brings a network interface or the firewall down, which is equivalent to cutting the network: this session and every networked program can lose their connection.'
  },
  SYSTEM_PROCESS_KILL: {
    level: 'high',
    zh: '会杀掉桌面或系统核心进程，可能立刻黑屏、注销或让系统失去响应，只能强制重启。',
    en: 'Kills a core desktop or system process; this can blank the screen, log the user out or hang the machine, leaving a forced restart as the only option.'
  },
  INIT_KILL: {
    level: 'high',
    zh: '会杀掉 init 进程，系统会立即崩溃并重启。',
    en: 'Kills the init process, which crashes and restarts the operating system immediately.'
  },
  SESSION_KILL: {
    level: 'high',
    zh: '会结束正在运行的 Harness 进程——也就是承载这次确认的会话本身，确认框会随之消失，无法再回答。',
    en: 'Kills the running Harness process, which is the very session showing this confirmation; the prompt disappears and can no longer be answered.'
  },

  // ---- system-level changes ----------------------------------------------
  SYSTEM_COMMAND: {
    level: 'medium',
    zh: '会改动系统级设置或服务，影响这台机器上的其他程序和其他登录用户；有些改动要管理员权限或重启才能恢复。',
    en: 'Changes machine-level settings or services, affecting other programs and other logged-in users on this machine; some of it needs admin rights or a reboot to undo.'
  },
  NETWORK_COMMAND: {
    level: 'medium',
    zh: '会与这台机器之外的服务通信：数据会离开本机，对方的响应会进入上下文，外部产生的影响无法撤回。',
    en: 'Talks to a service outside this machine: data leaves the host, whatever comes back enters the session context, and the remote side effects cannot be recalled.'
  },
  GLOBAL_INSTALL: {
    level: 'medium',
    zh: '会把软件装到项目之外（全局环境），可能连带升级共享依赖，从而让其他项目或工具失效。',
    en: 'Installs software outside the project, into the global environment; shared dependencies may be upgraded as a side effect and other projects or tools can break.'
  },
  PACKAGE_SUBCOMMAND: {
    level: 'medium',
    zh: '会改动包管理器在项目之外的共享状态（全局配置、缓存、发布内容），影响其他项目里的构建结果。',
    en: 'Touches package-manager state outside the project — global config, caches, published artifacts — which can change how other projects build.'
  },
  PATH_OUTSIDE: {
    level: 'medium',
    zh: '会读写项目之外的路径，可能改到其他项目、用户配置或系统文件；被覆盖的内容往往没有备份。',
    en: 'Reads or writes a path outside this project, which can touch other projects, user configuration or system files; overwritten content is usually not backed up.'
  },
  WORKDIR_OUTSIDE: {
    level: 'medium',
    zh: '命令将在项目之外执行，其中所有相对路径都会落在项目外，误伤范围可能超出预期。',
    en: 'Runs outside the project, so every relative path inside it lands outside the project too; the blast radius can be wider than it looks.'
  },
  PROGRAM_OUTSIDE: {
    level: 'medium',
    zh: '会执行项目之外的程序，可能不是你预期的那个版本，其行为无法从项目内容推断。',
    en: 'Executes a program from outside the project; it may not be the version you expect and its behaviour cannot be inferred from the project.'
  },
  GIT_REMOTE: {
    level: 'medium',
    zh: '会与远端仓库交互：可能把本地内容推到远端（包含敏感信息就收不回来），也可能覆盖本地未提交的改动。',
    en: 'Interacts with a remote repository: local content may be published (secrets included, irreversibly) or uncommitted local changes may be overwritten.'
  },

  // ---- resource exhaustion ------------------------------------------------
  UNBOUNDED_WRITE: {
    level: 'high',
    zh: '会产生没有上限的输出，可能迅速写满磁盘；磁盘满之后所有程序都无法写入，系统本身也会变得不稳定。',
    en: 'Produces unbounded output that can fill the disk within seconds; once the disk is full every program fails to write and the system itself becomes unstable.'
  },
  DISK_FILL: {
    level: 'high',
    zh: '会一次性申请大块磁盘空间，可能把磁盘占满，导致所有程序与系统日志无法写入。',
    en: 'Allocates a large file in one go, which can fill the disk and leave every program and the system log unable to write.'
  },
  LOAD_TEST: {
    level: 'high',
    zh: '会长时间占满 CPU 或内存，整机和其他所有程序都会明显变慢甚至失去响应。',
    en: 'Saturates CPU or memory for a sustained period; the machine and every other program slow to a crawl or stop responding.'
  },
  UNBOUNDED_LOOP: {
    level: 'medium',
    zh: '是个没有退出条件的循环，会一直占用 CPU 并持续产生输出，直到你手动终止它。',
    en: 'Loops without an exit condition, burning CPU and producing output until someone kills it by hand.'
  },
  PORT_BIND: {
    level: 'medium',
    zh: '会在本机端口上启动服务，可能与其他正在运行的服务抢端口，或把本机内容暴露到网络上。',
    en: 'Starts a server bound to a local port, which can conflict with an already running service or expose local content on the network.'
  },

  // ---- undecidable --------------------------------------------------------
  UNINSPECTABLE: {
    level: 'unknown',
    zh: '含有无法检查的内联代码或命令替换，插件无法判断它究竟会做什么，副作用可能超出这条命令看起来的范围。',
    en: 'Contains inline code or command substitution the plugin cannot read, so its real effects are unknown and may reach beyond what the command appears to do.'
  },
  VARIABLE_PATH: {
    level: 'unknown',
    zh: '把变量当作路径使用，插件无法知道它最终指向哪里，可能是项目内，也可能是系统目录。',
    en: 'Uses a variable as a path, so the plugin cannot tell where it really points — it may be inside the project, or inside a system directory.'
  },
  UNKNOWN_TOOL: {
    level: 'unknown',
    zh: '这个工具不在已知规则里，插件无法判断它的影响范围，请按你对该工具的了解来决定。',
    en: 'This tool is not in any known rule set, so its blast radius is unknown; decide from what you know about the tool.'
  },
  BAD_PATH_ARGUMENT: {
    level: 'unknown',
    zh: '路径参数的形状无法解析，插件不知道它会作用于哪些文件。',
    en: 'The path argument has a shape the plugin cannot parse, so which files it affects is unknown.'
  },
  NO_COMMAND: {
    level: 'unknown',
    zh: '这条 shell 调用读不到命令字符串，无法分析其影响。',
    en: 'This shell call carries no readable command string, so its effects cannot be analysed.'
  },
  CLASSIFIER_FAILURE: {
    level: 'unknown',
    zh: '影响分析本身出错了，无法判断这条调用的后果，请谨慎决定。',
    en: 'The impact analysis itself failed, so the consequences of this call are unknown; decide carefully.'
  },
  UNBALANCED: {
    level: 'unknown',
    zh: '引号不配对，命令的真实结构无法确定，实际执行的可能是另一条命令。',
    en: 'Unbalanced quotes mean the real structure of the command is unknown; what actually runs may be a different command.'
  },
  NO_PROJECT_ROOT: {
    level: 'unknown',
    zh: '当前会话解析不出项目根目录，因此无法判断这条调用是否在项目内。',
    en: 'The session has no resolvable project root, so whether this call stays inside the project cannot be decided.'
  },
  WORKDIR_MISSING: {
    level: 'unknown',
    zh: '缺少工作目录信息，无法判断相对路径会落在哪里。',
    en: 'The working directory is unknown, so where relative paths land cannot be decided.'
  },
  ASK_TOOL: {
    level: 'medium',
    zh: '会把工作交出去或改动会话之外的状态：子代理/工作流会自行执行更多调用，插件与定时任务会改变 Harness 的长期行为。',
    en: 'Hands work to something outside this call or changes state beyond the session: subagents and workflows run further calls of their own, while plugin and schedule changes alter the Harness long-term.'
  },
  USER_ASK: {
    level: 'medium',
    zh: '这条命令命中了你自定义的需要确认的规则。',
    en: 'This command matches a confirmation rule you configured yourself.'
  },

  // ---- generic fallbacks --------------------------------------------------
  OUTSIDE_GENERIC: {
    level: 'medium',
    zh: '会操作本项目之外的资源。',
    en: 'Touches resources outside this project.'
  },
  SYSTEM_GENERIC: {
    level: 'medium',
    zh: '属于系统级操作，可能影响这台机器上的其他程序或其他用户。',
    en: 'Is a system-level operation that can affect other programs or other users on this machine.'
  },
  UNKNOWN_GENERIC: {
    level: 'unknown',
    zh: '影响范围无法确定，可能有意料之外的副作用。',
    en: 'Its blast radius is undetermined, so unexpected side effects are possible.'
  }
};

/**
 * Per-program refinement for `SYSTEM_COMMAND` verdicts: the same "system-level"
 * label hides very different risks, and the user is deciding in seconds.
 */
const PROGRAM_IMPACTS = {
  sudo: { level: 'high', zh: '以 root 权限执行：命令的每一步都不再受你的用户权限限制，文件被改或被删通常无法撤销。', en: 'Runs as root: nothing constrains it to your user permissions, and what it changes or deletes usually cannot be undone.' },
  su: { level: 'high', zh: '切换到其他用户（通常是 root）执行，影响范围与权限都会超出当前会话。', en: 'Runs as another user (usually root), widening the permissions and blast radius beyond this session.' },
  doas: { level: 'high', zh: '以提升后的权限执行，影响范围超出当前用户。', en: 'Runs with elevated privileges, beyond what your user account allows.' },
  security: { level: 'high', zh: '会改动钥匙串或凭据：证书、密码可能被删除或替换，其他程序可能因此无法登录。', en: 'Changes the keychain or credentials: certificates and passwords can be deleted or replaced, and other programs may stop being able to authenticate.' },
  csrutil: { level: 'high', zh: '会改动系统完整性保护，等于降低系统的安全防线，恢复需要重启进恢复模式。', en: 'Changes System Integrity Protection, lowering the machine’s defences; undoing it requires rebooting into recovery mode.' },
  spctl: { level: 'high', zh: '会改动 Gatekeeper 策略，之后应用可以不经校验就运行，安全防线随之下降。', en: 'Changes the Gatekeeper policy so applications can run unchecked, weakening the machine’s defences.' },
  launchctl: { level: 'medium', zh: '会加载、停止或禁用系统服务：依赖该服务的程序会立刻失效，且可能需要重启才能恢复。', en: 'Loads, stops or disables a system service: programs depending on it break immediately and may need a reboot to recover.' },
  systemctl: { level: 'medium', zh: '会启停系统服务，依赖它的程序会随之中断。', en: 'Starts or stops a system service, interrupting whatever depends on it.' },
  service: { level: 'medium', zh: '会启停系统服务，依赖它的程序会随之中断。', en: 'Starts or stops a system service, interrupting whatever depends on it.' },
  defaults: { level: 'medium', zh: '会写入应用或系统偏好设置，可能改变其他程序的行为，而你不知道哪些程序依赖这些键值。', en: 'Writes application or system preferences, changing the behaviour of programs you may not realise depend on those keys.' },
  networksetup: { level: 'high', zh: '会改动网络配置：轻则切换 DNS/代理，重则直接断开网络，让当前会话与所有联网程序失联。', en: 'Changes network configuration: at best it rewrites DNS or proxy settings, at worst it cuts the connection and takes this session and every networked program offline.' },
  ifconfig: { level: 'high', zh: '会直接改动网络接口，可能立刻断开本机网络。', en: 'Changes a network interface directly and can cut the machine off the network immediately.' },
  ip: { level: 'high', zh: '会改动网络接口或路由，可能立刻断网。', en: 'Changes interfaces or routes and can cut the network immediately.' },
  nmcli: { level: 'high', zh: '会改动网络连接，可能立刻断网。', en: 'Changes network connections and can cut the network immediately.' },
  route: { level: 'high', zh: '会改动路由表，可能让流量走错方向或直接断网。', en: 'Changes the routing table, which can misdirect traffic or cut connectivity outright.' },
  pfctl: { level: 'high', zh: '会改动包过滤/防火墙规则，可能断开网络或让本机服务暴露出去。', en: 'Changes packet-filter or firewall rules, which can cut connectivity or expose local services.' },
  pmset: { level: 'medium', zh: '会改动电源与睡眠策略，机器可能在不该睡的时候休眠，长任务会中断。', en: 'Changes power and sleep policy; the machine may sleep mid-task and interrupt long-running work.' },
  diskutil: { level: 'high', zh: '会操作磁盘与宗卷，误操作可能直接导致数据丢失。', en: 'Operates on disks and volumes, where a wrong flag means immediate data loss.' },
  hdiutil: { level: 'medium', zh: '会挂载、卸载或改写磁盘映像，正在使用该映像的程序会中断。', en: 'Attaches, detaches or rewrites disk images, interrupting programs that use them.' },
  mount: { level: 'medium', zh: '会挂载文件系统，可能覆盖已有目录内容或让外部存储可写。', en: 'Mounts a filesystem, which can shadow existing directory contents or make external storage writable.' },
  umount: { level: 'medium', zh: '会卸载文件系统，正在读写它的程序会立刻失败或丢失未写入的数据。', en: 'Unmounts a filesystem; programs reading or writing it fail at once or lose unwritten data.' },
  fsck: { level: 'high', zh: '会检查并可能修改文件系统结构，处理不当会造成数据丢失。', en: 'Checks and may rewrite filesystem structures; mishandling it loses data.' },
  kill: { level: 'medium', zh: '会终止目标进程，该程序未保存的内容会直接丢失，且它可能正是你在用的程序。', en: 'Terminates the target process, losing whatever it had not saved — and the target may be a program you are using.' },
  killall: { level: 'medium', zh: '会按名字终止所有匹配进程，可能一次关掉多个正在使用的程序。', en: 'Terminates every process matching the name, possibly closing several programs you are using at once.' },
  pkill: { level: 'medium', zh: '会按模式终止进程，匹配范围可能比你预想的大得多。', en: 'Terminates processes by pattern, which can match far more than you intended.' },
  brew: { level: 'medium', zh: '会全局安装或升级软件包，可能连带升级共享依赖，导致其他项目或命令行工具失效。', en: 'Installs or upgrades packages globally; shared dependencies may be upgraded as well, breaking other projects or command-line tools.' },
  port: { level: 'medium', zh: '会通过 MacPorts 全局改动软件包，可能影响其他依赖它们的工具。', en: 'Changes packages globally through MacPorts and can break other tools that depend on them.' },
  mas: { level: 'medium', zh: '会安装或更新 App Store 应用，改动的是整个系统上的应用。', en: 'Installs or updates App Store applications across the whole machine.' },
  pip: { level: 'medium', zh: '会把包装进某个 Python 环境——很可能不是这个项目的虚拟环境，可能升级共享依赖并让其他脚本失效。', en: 'Installs into a Python environment that is likely not this project’s virtualenv, and can upgrade shared dependencies that other scripts rely on.' },
  pip3: { level: 'medium', zh: '会把包装进某个 Python 环境，可能不是当前项目的虚拟环境，升级共享依赖会让其他脚本失效。', en: 'Installs into a Python environment that may not be this project’s, and upgrading shared dependencies can break other scripts.' },
  conda: { level: 'medium', zh: '会在 conda 环境里安装或升级包，可能连带改动基础环境。', en: 'Installs or upgrades packages in a conda environment and can alter the base environment with them.' },
  mamba: { level: 'medium', zh: '会在 conda 环境里安装或升级包，可能连带改动基础环境。', en: 'Installs or upgrades packages in a conda environment and can alter the base environment with them.' },
  softwareupdate: { level: 'medium', zh: '会安装系统更新，过程中可能需要重启，其他程序会被中断。', en: 'Installs system updates, which can require a restart and interrupt every running program.' },
  installer: { level: 'medium', zh: '会安装系统级软件包，改动落在整个系统上。', en: 'Installs system-level packages, changing the machine as a whole.' },
  pkgutil: { level: 'medium', zh: '会改动已安装的软件包记录或展开安装包，可能影响系统软件管理状态。', en: 'Changes installed-package records or expands packages, affecting how the system tracks its software.' },
  osascript: { level: 'medium', zh: '会驱动其他应用程序（可能关闭、改动或删除它们的数据），行为取决于脚本内容。', en: 'Drives other applications — possibly quitting them or changing their data — and what it does depends entirely on the script.' },
  open: { level: 'medium', zh: '会启动或切换其他应用程序，可能打断你正在进行的操作或弹出窗口。', en: 'Launches or switches to another application, which can interrupt what you are doing or pop windows open.' },
  xargs: { level: 'medium', zh: '会把前面的输出当作参数执行命令，实际执行的内容取决于上游输出，很难预判。', en: 'Executes a command using upstream output as arguments, so what actually runs depends on that output and is hard to predict.' },
  sysctl: { level: 'medium', zh: '会读取或写入内核参数：读取影响很小，写入会立刻改变系统行为。', en: 'Reads or writes kernel parameters: reading is harmless, writing changes system behaviour immediately.' },
  nvram: { level: 'high', zh: '会改动固件变量，写入错误可能让机器无法启动，恢复成本很高。', en: 'Changes firmware variables; a bad write can stop the machine from booting and is expensive to undo.' },
  bless: { level: 'high', zh: '会改动启动卷设置，设错可能导致机器无法启动。', en: 'Changes which volume the machine boots from; a wrong value can make it unbootable.' },
  chflags: { level: 'medium', zh: '会改动文件系统标志（例如锁定、隐藏），可能让文件无法编辑或从界面消失。', en: 'Changes filesystem flags such as locked or hidden, which can make files uneditable or invisible.' },
  dscacheutil: { level: 'low', zh: '会刷新目录服务缓存，影响很小，只是其他程序可能短暂变慢。', en: 'Flushes the directory-services cache; the effect is small beyond a brief slowdown for other programs.' },
  mdutil: { level: 'medium', zh: '会重建或关闭 Spotlight 索引，期间搜索与其他程序会变慢。', en: 'Rebuilds or disables the Spotlight index, slowing search and other programs while it runs.' },
  updatedb: { level: 'medium', zh: '会重建全盘文件索引，期间磁盘与 CPU 会被占用，其他程序会变慢。', en: 'Rebuilds a whole-disk file index, consuming disk and CPU while other programs slow down.' },
  ps: { level: 'low', zh: '只读取进程列表，本身不改动系统。', en: 'Only reads the process list and changes nothing by itself.' },
  top: { level: 'low', zh: '只读取系统负载信息。', en: 'Only reads system load information.' },
  lsof: { level: 'low', zh: '只读取打开的文件与端口列表，可能暴露其他程序的运行信息。', en: 'Only reads open files and ports, though it can reveal other programs’ runtime details.' },
  netstat: { level: 'low', zh: '只读取网络连接状态。', en: 'Only reads network connection state.' },
  system_profiler: { level: 'low', zh: '只读取硬件与系统信息，不改动任何设置。', en: 'Only reads hardware and system information; nothing is changed.' },
  scutil: { level: 'medium', zh: '会读取或改写系统配置（主机名、DNS 等），写入会影响所有联网程序。', en: 'Reads or rewrites system configuration such as host name and DNS, and writes affect every networked program.' },
  systemsetup: { level: 'medium', zh: '会改动时区、时间、远程登录等系统设置，通常需要管理员权限。', en: 'Changes time zone, clock, remote login and similar system settings, usually requiring admin rights.' },
  kextload: { level: 'high', zh: '会加载内核扩展，错误的驱动可能让系统崩溃或无法启动。', en: 'Loads a kernel extension; a bad driver can crash or prevent the machine from booting.' },
  kextutil: { level: 'high', zh: '会加载或诊断内核扩展，错误的驱动可能让系统崩溃。', en: 'Loads or diagnoses kernel extensions; a bad driver can crash the system.' },
  kmutil: { level: 'high', zh: '会改动内核扩展集合，错误的改动可能让机器无法启动。', en: 'Changes the kernel-extension collection; a wrong change can leave the machine unbootable.' },
  ioreg: { level: 'low', zh: '只读取 I/O 注册表信息。', en: 'Only reads the I/O registry.' },
  log: { level: 'low', zh: '会读取或改动系统日志流，读取影响很小。', en: 'Reads or alters the system log stream; reading has little effect.' },
  dnf: { level: 'medium', zh: '会全局安装或升级系统软件包，可能连带升级共享依赖。', en: 'Installs or upgrades system packages globally, potentially dragging shared dependencies with them.' },
  apt: { level: 'medium', zh: '会全局安装或升级系统软件包，可能连带升级共享依赖。', en: 'Installs or upgrades system packages globally, potentially dragging shared dependencies with them.' },
  'apt-get': { level: 'medium', zh: '会全局安装或升级系统软件包，可能连带升级共享依赖。', en: 'Installs or upgrades system packages globally, potentially dragging shared dependencies with them.' },
  yum: { level: 'medium', zh: '会全局安装或升级系统软件包。', en: 'Installs or upgrades system packages globally.' },
  pacman: { level: 'medium', zh: '会全局安装或升级系统软件包。', en: 'Installs or upgrades system packages globally.' },
  zypper: { level: 'medium', zh: '会全局安装或升级系统软件包。', en: 'Installs or upgrades system packages globally.' },
  rpm: { level: 'medium', zh: '会安装、升级或删除系统软件包。', en: 'Installs, upgrades or removes system packages.' },
  dpkg: { level: 'medium', zh: '会安装或删除系统软件包，可能留下依赖破损。', en: 'Installs or removes system packages and can leave dependencies broken.' },
  snap: { level: 'medium', zh: '会全局安装或移除 snap 软件包。', en: 'Installs or removes snap packages globally.' },
  flatpak: { level: 'medium', zh: '会全局安装或移除 flatpak 应用。', en: 'Installs or removes flatpak applications globally.' },
  stress: { level: 'high', zh: '会刻意占满 CPU/内存/磁盘，机器与其他程序会明显卡顿甚至失去响应。', en: 'Deliberately saturates CPU, memory or disk; the machine and other programs stutter or stop responding.' },
  'stress-ng': { level: 'high', zh: '会刻意占满 CPU/内存/磁盘，机器与其他程序会明显卡顿甚至失去响应。', en: 'Deliberately saturates CPU, memory or disk; the machine and other programs stutter or stop responding.' },
  chsh: { level: 'medium', zh: '会改动登录 shell，改错会导致终端无法正常登录。', en: 'Changes the login shell; a wrong value can leave terminals unable to log in.' },
  passwd: { level: 'medium', zh: '会改动账户密码，忘记新密码会把自己锁在外面。', en: 'Changes an account password; forgetting the new one locks you out.' },
  dscl: { level: 'medium', zh: '会改动目录服务里的用户与组，影响登录与权限。', en: 'Changes users and groups in directory services, affecting logins and permissions.' },
  'dseditgroup': { level: 'medium', zh: '会改动用户组，权限范围随之变化。', en: 'Changes group membership, which changes what is permitted.' },
  sysadminctl: { level: 'medium', zh: '会改动本机账户或安全设置。', en: 'Changes local accounts or security settings.' },
  shutdown: { level: 'high', zh: '会关机，所有程序与当前会话立即结束。', en: 'Shuts the machine down; every program and this session end immediately.' },
  reboot: { level: 'high', zh: '会重启，所有程序与当前会话立即结束，未保存的工作丢失。', en: 'Reboots; every program and this session end immediately and unsaved work is lost.' },
  halt: { level: 'high', zh: '会停机，机器必须手动重新开机。', en: 'Halts the machine, which then has to be powered on by hand.' },
  dd: { level: 'high', zh: '会按块读写设备或文件，写错目标就是不可恢复的数据丢失。', en: 'Reads and writes devices or files block by block; a wrong target means unrecoverable data loss.' },
  mkfs: { level: 'high', zh: '会创建新文件系统，目标设备上的数据全部丢失。', en: 'Creates a fresh filesystem, destroying everything already on the target device.' },
  newfs: { level: 'high', zh: '会创建新文件系统，目标卷上的数据全部丢失。', en: 'Creates a fresh filesystem, destroying everything already on the target volume.' },
  fdisk: { level: 'high', zh: '会改动分区表，错误操作会让磁盘无法挂载或系统无法启动。', en: 'Edits the partition table; a mistake can leave the disk unmountable or the machine unbootable.' },
  gpt: { level: 'high', zh: '会改动分区表，错误操作会让磁盘无法挂载或系统无法启动。', en: 'Edits the partition table; a mistake can leave the disk unmountable or the machine unbootable.' },
  firmwarepasswd: { level: 'high', zh: '会改动固件密码，设置错误可能让机器无法启动或无法进入恢复模式。', en: 'Changes the firmware password; a wrong value can lock the machine out of booting or recovery.' },
  asr: { level: 'high', zh: '会整盘还原或校验镜像，目标卷数据会被覆盖。', en: 'Restores a whole volume from an image, overwriting whatever is on the target.' },
  caffeinate: { level: 'low', zh: '只会阻止机器休眠，通常无副作用，但长时间运行会持续耗电。', en: 'Only prevents sleep; usually harmless, though it keeps drawing power for as long as it runs.' },
  renice: { level: 'low', zh: '会调整进程优先级，只影响调度，不会终止程序。', en: 'Adjusts process priority; it changes scheduling only and never terminates a program.' },
  hostname: { level: 'low', zh: '通常只读取主机名。', en: 'Usually just reads the host name.' },
  uptime: { level: 'low', zh: '只读取运行时长与负载。', en: 'Only reads uptime and load.' },
  sw_vers: { level: 'low', zh: '只读取系统版本。', en: 'Only reads the system version.' },
  uname: { level: 'low', zh: '只读取内核与架构信息。', en: 'Only reads kernel and architecture information.' },
  arch: { level: 'low', zh: '只读取 CPU 架构。', en: 'Only reads the CPU architecture.' },
  vm_stat: { level: 'low', zh: '只读取内存统计。', en: 'Only reads memory statistics.' },
  crontab: { level: 'medium', zh: '会改动定时任务：之后会有一批命令在你不知情的时候反复执行。', en: 'Changes scheduled jobs, so commands will keep running later without you watching.' },
  at: { level: 'medium', zh: '会安排一个稍后执行的任务，届时的影响你无法即时看到。', en: 'Schedules a job for later, whose effects you will not be watching when they happen.' },
  atq: { level: 'low', zh: '只列出待执行的定时任务。', en: 'Only lists pending scheduled jobs.' },
  atrm: { level: 'low', zh: '会取消已排队的定时任务。', en: 'Cancels a queued scheduled job.' },
  launchd: { level: 'medium', zh: '会与系统服务管理器交互，可能启停后台服务。', en: 'Interacts with the service manager and can start or stop background services.' },
  sc: { level: 'medium', zh: '会与系统服务管理器交互，可能启停后台服务。', en: 'Interacts with the service manager and can start or stop background services.' },
  batch: { level: 'medium', zh: '会排队一个稍后执行的任务。', en: 'Queues a job to run later.' },
  socketfilterfw: { level: 'high', zh: '会改动系统防火墙，可能让本机端口暴露或直接断网。', en: 'Changes the system firewall, which can expose local ports or cut connectivity.' },
  airport: { level: 'high', zh: '会改动 Wi-Fi 状态或配置，可能直接断网。', en: 'Changes Wi-Fi state or configuration and can cut the connection outright.' },
  blueutil: { level: 'medium', zh: '会开关蓝牙，正在使用的蓝牙设备会断开。', en: 'Turns Bluetooth on or off, disconnecting whatever is using it.' },
  iwconfig: { level: 'high', zh: '会改动无线接口配置，可能立刻断网。', en: 'Changes wireless interface configuration and can cut the network immediately.' },
  iw: { level: 'high', zh: '会改动无线接口配置，可能立刻断网。', en: 'Changes wireless interface configuration and can cut the network immediately.' },
  arp: { level: 'medium', zh: '会改动 ARP 缓存，可能短暂影响局域网内与其他设备的通信。', en: 'Changes the ARP cache, which can briefly disrupt communication with other devices on the LAN.' },
  wg: { level: 'high', zh: '会改动 VPN 隧道，可能直接断网或让流量走错出口。', en: 'Changes a VPN tunnel, which can cut connectivity or send traffic through the wrong exit.' },
  'wg-quick': { level: 'high', zh: '会启停 VPN 隧道，可能直接断网。', en: 'Starts or stops a VPN tunnel and can cut the network outright.' },
  tcpdump: { level: 'low', zh: '会抓取网络报文，可能读取到明文流量中的敏感内容。', en: 'Captures network packets and can expose sensitive content in cleartext traffic.' },
};

/** Generic fallbacks by verdict scope. */
const SCOPE_IMPACTS = {
  system: CODE_IMPACTS.SYSTEM_GENERIC,
  outside: CODE_IMPACTS.OUTSIDE_GENERIC,
  unknown: CODE_IMPACTS.UNKNOWN_GENERIC,
  project: CODE_IMPACTS.UNKNOWN_GENERIC
};

/**
 * Assess what goes wrong if the user allows this call.
 *
 * @param {{kind: string, scope: string, code: string, detail?: unknown}} verdict
 * @returns {{level: 'high'|'medium'|'low'|'unknown', en: string, zh: string} | undefined}
 *   `undefined` for calls that never reach the user.
 */
export function describeImpact(verdict) {
  if (verdict === undefined || verdict.kind === 'allow') return undefined;
  if (verdict.code === 'SYSTEM_COMMAND' && typeof verdict.detail === 'string') {
    const perProgram = PROGRAM_IMPACTS[verdict.detail];
    if (perProgram !== undefined) return perProgram;
  }
  return CODE_IMPACTS[verdict.code] ?? SCOPE_IMPACTS[verdict.scope] ?? CODE_IMPACTS.UNKNOWN_GENERIC;
}

/** Render the impact as the warning line the confirmation prompt shows. */
export function impactLine(impact) {
  if (impact === undefined) return undefined;
  return {
    en: `Possible adverse outcome (${LEVEL_LABELS.en[impact.level] ?? 'unknown'}): ${impact.en}`,
    zh: `可能的不良结果（${LEVEL_LABELS.zh[impact.level] ?? '未知'}）：${impact.zh}`
  };
}
