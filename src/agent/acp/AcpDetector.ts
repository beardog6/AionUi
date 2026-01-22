/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProcessConfig } from '@/process/initStorage';
import type { AcpBackendAll, PotentialAcpCli } from '@/types/acpTypes';
import { POTENTIAL_ACP_CLIS } from '@/types/acpTypes';
import fs from 'fs';
import path from 'path';

interface DetectedAgent {
  backend: AcpBackendAll;
  name: string;
  cliPath?: string;
  acpArgs?: string[];
  customAgentId?: string; // UUID for custom agents
  isPreset?: boolean;
  context?: string;
  avatar?: string;
  presetAgentType?: 'gemini' | 'claude' | 'codex'; // Primary agent type for presets
}

/**
 * 全局ACP检测器 - 启动时检测一次，全局共享结果
 */
class AcpDetector {
  private detectedAgents: DetectedAgent[] = [];
  private isDetected = false;

  /**
   * 将自定义代理添加到检测列表（追加到末尾）
   * Add custom agents to detected list if configured and enabled (appends to end).
   */
  private async addCustomAgentsToList(detected: DetectedAgent[]): Promise<void> {
    try {
      const customAgents = await ProcessConfig.get('acp.customAgents');
      if (!customAgents || !Array.isArray(customAgents) || customAgents.length === 0) return;

      // 过滤出已启用且有有效 CLI 路径或标记为预设的代理 / Filter enabled agents with valid CLI path or marked as preset
      const enabledAgents = customAgents.filter((agent) => agent.enabled && (agent.defaultCliPath || agent.isPreset));
      if (enabledAgents.length === 0) return;

      // 将所有自定义代理追加到列表末尾 / Append all custom agents to the end
      const customDetectedAgents: DetectedAgent[] = enabledAgents.map((agent) => ({
        backend: 'custom',
        name: agent.name || 'Custom Agent',
        cliPath: agent.defaultCliPath,
        acpArgs: agent.acpArgs,
        customAgentId: agent.id, // 存储 UUID 用于标识 / Store the UUID for identification
        isPreset: agent.isPreset,
        context: agent.context,
        avatar: agent.avatar,
        presetAgentType: agent.presetAgentType, // 主 Agent 类型 / Primary agent type
      }));

      detected.push(...customDetectedAgents);
    } catch (error) {
      // 配置读取失败时区分预期错误和非预期错误
      // Distinguish expected vs unexpected errors when reading config
      if (error instanceof Error && (error.message.includes('ENOENT') || error.message.includes('not found'))) {
        // 未配置自定义代理 - 这是正常情况 / No custom agents configured - this is normal
        return;
      }
      console.warn('[AcpDetector] Unexpected error loading custom agents:', error);
    }
  }

  /**
   * 启动时执行检测 - 使用 POTENTIAL_ACP_CLIS 列表检测已安装的 CLI
   * 使用文件系统直接检测，不依赖 execSync，提升速度和稳定性
   */
  async initialize(): Promise<void> {
    if (this.isDetected) return;

    console.log('[ACP] ===================== ACP Detection Started =====================');
    const startTime = Date.now();
    const isWindows = process.platform === 'win32';

    // 1. 收集所有可能的搜索路径 / Collect all possible search paths
    const envPath = process.env.PATH || '';
    const searchPaths = envPath.split(path.delimiter).filter((p) => p && p.trim() !== '');

    // 2. 强制补充常见但可能不在 PATH 中的目录 (针对 Linux/Docker 环境)
    //    Force add common paths that might be missing from non-interactive shell PATH
    if (!isWindows) {
      const extraPaths = [
        '/usr/local/share/npm-global/bin', // npm 全局安装位置
        '/usr/local/bin', // 常见软连接位置
        '/usr/bin',
        '/bin',
        '/opt/homebrew/bin', // macOS Homebrew
        path.join(process.env.HOME || '/root', '.npm-global/bin'), // 用户级安装
      ];

      // 去重添加 / Deduplicate and add
      for (const p of extraPaths) {
        if (!searchPaths.includes(p)) {
          searchPaths.push(p);
        }
      }
    }

    console.log(`[ACP] Search Directories (${searchPaths.length}):`);
    // 打印前3个和包含 npm-global 的路径验证
    // Print first 3 paths and verify npm-global path
    searchPaths.slice(0, 3).forEach((d, i) => console.log(`[ACP]   [${i}] ${d}`));
    const npmPath = searchPaths.find((p) => p.includes('npm-global'));
    if (npmPath) console.log(`[ACP]   [...] ${npmPath} (Explicitly Added)`);

    const detected: DetectedAgent[] = [];

    // 定义核心检测函数：只使用 fs，不使用 exec
    // Define core detection function: only use fs, not exec
    const detectCli = (cli: PotentialAcpCli): DetectedAgent | null => {
      console.log(`[ACP] 🔍 Scanning for: ${cli.cmd}`);

      for (const dir of searchPaths) {
        try {
          // 构造完整路径 / Construct full path
          const fullPath = path.join(dir, cli.cmd + (isWindows ? '.exe' : ''));

          // Step 1: 检查文件是否存在 / Step 1: Check if file exists
          if (fs.existsSync(fullPath)) {
            // Step 2: 检查是否有执行权限 (仅 Linux/Mac) / Step 2: Check execution permission (Linux/Mac only)
            if (!isWindows) {
              try {
                fs.accessSync(fullPath, fs.constants.X_OK);
              } catch (permErr) {
                // 文件存在但不可执行，跳过 / File exists but not executable, skip
                continue;
              }
            }

            console.log(`[ACP] ✅ Found: ${cli.name} (${cli.backendId})`);
            console.log(`[ACP]    Path: ${fullPath}`);

            return {
              backend: cli.backendId,
              name: cli.name,
              cliPath: fullPath,
              acpArgs: cli.args,
            } as DetectedAgent;
          }
        } catch (err) {
          // 忽略单个路径的访问错误（如权限不足的目录）
          // Ignore errors for individual paths (e.g., permission denied)
        }
      }
      return null;
    };

    // 执行检测 / Execute detection
    for (const cli of POTENTIAL_ACP_CLIS) {
      const result = detectCli(cli);
      if (result) detected.push(result);
    }

    // 添加内置 Gemini / Add built-in Gemini
    if (detected.length > 0) {
      detected.unshift({
        backend: 'gemini',
        name: 'Gemini CLI',
        cliPath: undefined,
        acpArgs: undefined,
      });
    }

    await this.addCustomAgentsToList(detected);
    this.detectedAgents = detected;
    this.isDetected = true;

    const elapsed = Date.now() - startTime;
    console.log(`[ACP] ==================== Detection Completed ====================`);
    console.log(`[ACP] Total Time: ${elapsed}ms`);
    console.log(`[ACP] Detected Agents Count: ${detected.length}`);
    detected.forEach((agent, index) => {
      console.log(`[ACP]   ${index + 1}. ${agent.name} (${agent.cliPath || 'Built-in'})`);
    });
    console.log('[ACP] ==================================================');
  }

  /**
   * 获取检测结果
   */
  getDetectedAgents(): DetectedAgent[] {
    return this.detectedAgents;
  }

  /**
   * 是否有可用的ACP工具
   */
  hasAgents(): boolean {
    return this.detectedAgents.length > 0;
  }

  /**
   * Refresh custom agents detection only (called when config changes)
   */
  async refreshCustomAgents(): Promise<void> {
    // Remove existing custom agents if present
    this.detectedAgents = this.detectedAgents.filter((agent) => agent.backend !== 'custom');

    // Re-add custom agents with current config
    await this.addCustomAgentsToList(this.detectedAgents);
  }
}

// 单例实例
export const acpDetector = new AcpDetector();
