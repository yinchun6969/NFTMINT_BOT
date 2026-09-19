"use strict";

const {
  AUTH_FILE,
  createPasswordRecord,
  saveAuthRecord,
  validatePassword,
} = require("./auth");

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("密码设置必须在 VPS 本机终端或 SSH 终端中运行"));
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error, result) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("已取消密码设置"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(null, value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const first = await readHidden("设置 Mint Forge 应用密码（不会显示）：");
  validatePassword(first);
  const second = await readHidden("再次输入应用密码：");
  if (first !== second) throw new Error("两次输入的密码不一致");
  saveAuthRecord(createPasswordRecord(first));
  console.log(`密码哈希已保存：${AUTH_FILE}`);
  console.log("请保持该文件权限为 600，不要提交到 GitHub。重启 npm start 后生效。");
}

main().catch((error) => {
  console.error(`密码设置失败：${error.message}`);
  process.exitCode = 1;
});
