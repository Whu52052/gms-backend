#!/bin/bash
# 自动构建并导出 Docker 镜像

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="gms-heartbeat-agent"
IMAGE_TAG="latest"
OUTPUT_DIR="${SCRIPT_DIR}"
OUTPUT_FILE="${OUTPUT_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"

echo "=========================================="
echo "  GMS 心跳代理 - 镜像构建与导出"
echo "=========================================="
echo ""

# 1. 构建镜像
echo "[1/3] 构建 Docker 镜像..."
cd "${SCRIPT_DIR}"
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .
echo "✅ 镜像构建完成"
echo ""

# 2. 导出镜像
echo "[2/3] 导出镜像到 tar 文件..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" -o "${OUTPUT_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar"
echo "✅ 镜像已导出"
echo ""

# 3. 压缩
echo "[3/3] 压缩镜像文件..."
gzip -f "${OUTPUT_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar"
echo "✅ 压缩完成"
echo ""

# 显示结果
echo "=========================================="
echo "  导出完成！"
echo "=========================================="
echo ""
echo "镜像文件: ${OUTPUT_FILE}"
echo "文件大小: $(du -h "${OUTPUT_FILE}" | cut -f1)"
echo ""
echo "使用方法："
echo "  1. 将文件复制到目标主机"
echo "  2. 解压并导入镜像："
echo "     gunzip -c ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz | docker load"
echo "  3. 启动容器："
echo "     cd machine-heartbeat-agent/"
echo "     docker-compose up -d"
echo ""
