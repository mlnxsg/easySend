import os from 'node:os';
import qrcode from 'qrcode-terminal';

/** 找出局域网 IPv4 地址。优先常见的家用网段，排除虚拟网卡。 */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // 跳过 VMware / VirtualBox / WSL / Docker 之类的虚拟网卡
      if (/vmware|virtualbox|vethernet|wsl|docker|loopback/i.test(name)) continue;
      out.push({ name, address: addr.address });
    }
  }
  // 192.168.* 和 10.* 最可能是手机能连到的那个
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}

function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith('169.254.')) return 9; // 自动专用地址，基本没用
  return 5;
}

export function printBanner({ port, token }) {
  const lans = lanAddresses();
  const phoneUrl = lans.length ? `http://${lans[0].address}:${port}` : null;
  const localUrl = `http://localhost:${port}`;

  console.log('');
  console.log('  ┌─ eSend ────────────────────────────────────────');
  console.log(`  │  白板   ${localUrl}`);
  console.log('  │         ↑ 电脑上务必用 localhost 打开，否则浏览器禁用「复制图片」');
  if (phoneUrl) {
    console.log(`  │  手机   ${phoneUrl}/api/upload`);
    console.log(`  │         ↑ 填进快捷指令的 URL（网卡：${lans[0].name}）`);
  } else {
    console.log('  │  手机   ⚠ 没找到局域网 IP，检查是否连着 Wi-Fi');
  }
  console.log(`  │  令牌   ${token}`);
  console.log('  └────────────────────────────────────────────────');

  if (lans.length > 1) {
    console.log(`  其他网卡：${lans.slice(1).map((l) => `${l.address} (${l.name})`).join('，')}`);
    console.log('  如果手机连不上，换上面这些地址试试。');
  }

  if (phoneUrl) {
    console.log('\n  扫码可在手机上打开白板（只是方便核对地址通不通，日常用不到）：');
    qrcode.generate(phoneUrl, { small: true });
  }
  console.log('  首次运行 Windows 会弹防火墙提示 → 必须勾选「专用网络」并允许，否则手机连不上。\n');
}
