#!/bin/bash

# 1. 安装生产环境依赖
echo "开始安装环境依赖..."
npm install --save --omit=dev

# 检查依赖是否安装成功 ($? 是上一个命令的退出状态码)
if [ $? -ne 0 ]; then
    echo "依赖安装失败，请检查网络或配置！"
    exit 1
fi

# 2. 运行主程序
echo "依赖安装完成，开始运行 Node.js 应用..."
node app.js
