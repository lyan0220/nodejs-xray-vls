#!/usr/bin/env node
// app.js - Xray内核 VLESS代理服务脚本
// 专为 64MB Pterodactyl 容器优化

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

// ======================================================================
// 核心配置区
// ======================================================================
const DOMAIN = "cloudflare.182682.xyz";  // 你的域名（Cloudflare 代理开启橙色云朵）
const UUID = "";  // UUID变量，留空自动生成或写入固定值
const PORT = "";  // 建议留空将自动使用分配的端口
const NAME = "Panel";  // 节点名称，将显示在客户端
// ======================================================================

class XrayProxy {
    constructor(domain, user_uuid, port, name) {
        this.uuid = user_uuid || crypto.randomUUID();
        this.path = "/" + crypto.randomBytes(4).toString('hex');
        this.domain = domain;
        this.port = port;
        this.process = null;
        this.xrayPath = path.join(__dirname, 'xray', 'xray');
        this.name = name;
        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        const cleanupAndExit = () => {
            console.log("\nStopping service...");
            this.cleanup();
            process.exit(0);
        };
        process.on('SIGINT', cleanupAndExit);
        process.on('SIGTERM', cleanupAndExit);
    }

    async detectPterodactyl() {
        const isPterodactyl = process.env.SERVER_IP && process.env.SERVER_PORT;
        const envInfo = {
            SERVER_MEMORY: process.env.SERVER_MEMORY,
            SERVER_IP: process.env.SERVER_IP,
            SERVER_PORT: process.env.SERVER_PORT
        };
        if (isPterodactyl) {
            console.log("✓ Pterodactyl environment detected.");
            for (const key in envInfo) {
                console.log(`✓ Detected ${key}: ${envInfo[key]}`);
            }
        } else {
            console.log("❌ Pterodactyl environment not detected, exiting.");
            process.exit(1);
        }
        return {
            serverIp: envInfo.SERVER_IP,
            directPort: parseInt(envInfo.SERVER_PORT)
        };
    }

    async getISP(retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const isp = await new Promise((resolve, reject) => {
                    const req = https.get('https://speed.cloudflare.com/meta', (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                const info = JSON.parse(data);
                                resolve(`${info.country}-${info.asOrganization}`.replace(/ /g, '_'));
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    req.on('error', reject);
                    req.end();
                });
                console.log(`✓ ISP detected: ${isp}`);
                return isp;
            } catch (e) {
                console.log(`第${attempt}次尝试获取ISP失败: ${e.message}`);
                if (attempt === retries) {
                    console.log("❌ ISP信息获取失败，使用'Unknown'");
                    return 'Unknown';
                }
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    getXrayDownloadUrl() {
        const archMap = { 'x64': 'amd64', 'arm64': 'arm64' };
        const arch = archMap[os.arch()] || 'amd64';
        const filename = arch === 'amd64' ? "Xray-linux-64.zip" : "Xray-linux-arm64-v8a.zip";
        return `https://github.com/XTLS/Xray-core/releases/latest/download/${filename}`;
    }

    async downloadXray(retries = 3) {
        const url = this.getXrayDownloadUrl();
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`Downloading Xray (attempt ${attempt}) from: ${url}`);
                return await this._downloadFile(url, 'xray.zip');
            } catch (e) {
                console.log(`第${attempt}次下载Xray失败: ${e.message}`);
                if (attempt === retries) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    async _downloadFile(url, dest) {
        return new Promise((resolve, reject) => {
            const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    console.log(`Redirecting to: ${response.headers.location}`);
                    return this._downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                }
                if (response.statusCode !== 200) {
                    return reject(new Error(`Download failed: HTTP status ${response.statusCode}`));
                }
                const fileStream = fs.createWriteStream(dest);
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log("Download complete.");
                    resolve(true);
                });
                fileStream.on('error', reject);
            }).on('error', reject);
        });
    }

    async extractXray() {
        const zipPath = 'xray.zip';
        if (!fs.existsSync(zipPath)) {
            console.log("✗ xray.zip does not exist, skipping extraction.");
            return false;
        }
        console.log("Extracting Xray...");
        return new Promise((resolve, reject) => {
            yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);
                let extracted = false;
                zipfile.on('entry', (entry) => {
                    const entryPath = entry.fileName;
                    if (entryPath.includes('xray')) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) return reject(err);
                            const writeStream = fs.createWriteStream(this.xrayPath);
                            pipeline(readStream, writeStream)
                                .then(() => {
                                    fs.chmodSync(this.xrayPath, 0o755);
                                    fs.unlinkSync(zipPath);
                                    console.log("Extraction and cleanup complete.");
                                    extracted = true;
                                    resolve(true);
                                })
                                .catch(reject);
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });
                zipfile.on('end', () => {
                    if (!extracted) {
                        console.error("❌ Error: Xray executable not found in zip file.");
                        resolve(false);
                    }
                });
                zipfile.readEntry();
            });
        });
    }

    generateConfig() {
        const config = {
            "log": { "loglevel": "error" },
            "inbounds": [
                {
                    "port": this.port,
                    "listen": "0.0.0.0",
                    "protocol": "vless",
                    "settings": {
                        "clients": [{ "id": this.uuid, "level": 0 }],
                        "decryption": "none"
                    },
                    "streamSettings": {
                        "network": "ws",
                        "security": "none",
                        "wsSettings": {
                            "path": this.path,
                            "headers": { "Host": this.domain }
                        }
                    }
                }
            ],
            "outbounds": [{ "protocol": "freedom", "settings": {} }],
            "policy": { "levels": { "0": { "bufferSize": 256, "connIdle": 120 } } }
        };
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    }

    displayInfo(ispInfo) {
        console.log("\n" + "=".repeat(60));
        console.log("VLESS Xray CDN-only service is now running");
        console.log("=".repeat(60));
        
        const nodeName = `${this.name}-${ispInfo}`;
        const cdnLink = `vless://${this.uuid}@${this.domain}:443?encryption=none&security=tls&type=ws&host=${encodeURIComponent(this.domain)}&path=${encodeURIComponent(this.path)}&sni=${encodeURIComponent(this.domain)}#${encodeURIComponent(nodeName)}`;

        console.log(`\n🔗 **CDN 节点链接**:\n${cdnLink}`);
        
        fs.writeFileSync('vless_xray_links.txt', `CDN 节点：\n${cdnLink}`);
        
        console.log(`\n链接已保存到: vless_xray_links.txt`);
        console.log("\n⚠ **重要提示**:");
        console.log(`1. 这个节点仅支持 CDN 代理，请确保你的域名 (${this.domain}) 在 Cloudflare 已开启代理（橙色云朵）。`);
        console.log(`2. 你需要通过 Cloudflare 的 **Origin Rules** 将流量路由到代理监听端口 (${this.port})。`);
        console.log(`3. Cloudflare 的 SSL/TLS 加密模式必须为 **灵活 (Flexible)**。`);
        console.log("\n✅ 服务运行中 (Ctrl+C to stop)");
    }

    startService() {
        // 调整 GOMEMLIMIT 以进一步限制内存使用
        const env = { ...process.env, GOMEMLIMIT: '10MiB', GOGC: '15' };
        this.process = spawn(this.xrayPath, ['run', '-config', 'config.json'], {
            env,
            stdio: ['ignore', 'ignore', 'pipe']
        });

        this.process.stderr.on('data', (data) => {
            console.error(`Xray stderr: ${data}`);
        });

        this.process.on('close', (code) => {
            if (code !== 0) {
                console.log(`Xray process exited with code ${code}`);
            }
        });
    }

    cleanup() {
        if (this.process) {
            this.process.kill('SIGTERM');
        }
        const filesToClean = ['xray.zip', 'config.json', 'vless_xray_links.txt'];
        for (const file of filesToClean) {
            try {
                if (fs.existsSync(file)) {
                    if (fs.lstatSync(file).isDirectory()) {
                        fs.rmSync(file, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(file);
                    }
                }
            } catch (e) {
                console.error(`Failed to clean up ${file}: ${e}`);
            }
        }
        if (fs.existsSync(this.xrayPath)) {
             try { fs.rmSync(path.dirname(this.xrayPath), { recursive: true, force: true }); } catch (e) { console.error(`Failed to clean up Xray folder: ${e}`); }
        }
    }
}

async function main() {
    try {
        const env = await new XrayProxy().detectPterodactyl();
        const containerPort = PORT === "" ? env.directPort : parseInt(PORT);
        const proxy = new XrayProxy(DOMAIN, UUID, containerPort, NAME);

        if (!fs.existsSync(path.join(__dirname, 'xray'))) {
            fs.mkdirSync(path.join(__dirname, 'xray'));
        }
        
        const ispInfo = await proxy.getISP();

        if (await proxy.downloadXray() && await proxy.extractXray()) {
            proxy.generateConfig();
            proxy.displayInfo(ispInfo);
            proxy.startService();
        } else {
            console.log("❌ Failed to start the service.");
            proxy.cleanup();
            process.exit(1);
        }
    } catch (e) {
        console.error("An error occurred:", e);
        process.exit(1);
    }
}

main();
