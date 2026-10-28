import os, sqlite3, shutil, tempfile, time

def probe(label, path):
    if not os.path.exists(path):
        print(f"[{label}] 无 Cookies: {path}")
        return
    tmp = os.path.join(tempfile.gettempdir(), "cookprobe_%d.db" % abs(hash(path)))
    try:
        shutil.copy2(path, tmp)
    except Exception as e:
        print(f"[{label}] 复制失败（可能被占用）: {e}")
        return
    try:
        con = sqlite3.connect(tmp)
        rows = con.execute(
            "select host_key, name, length(encrypted_value), expires_utc from cookies where host_key like '%zhipin%'"
        ).fetchall()
        print(f"[{label}] zhipin cookie 条数 = {len(rows)}")
        for host, name, n, exp in sorted(rows, key=lambda r: (r[1], r[0])):
            print(f"    {host:28s} {name:24s} {n:5d}B")
        con.close()
    except Exception as e:
        print(f"[{label}] 查询失败: {e}")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


local = os.environ["LOCALAPPDATA"]
chrome_ud = os.path.join(local, "Google", "Chrome", "User Data")
edge_ud = os.path.join(local, "Microsoft", "Edge", "User Data")
edge_ud2 = os.path.join(os.environ["APPDATA"], "Microsoft", "Edge", "User Data")

for base, tag in ((chrome_ud, "Chrome"), (edge_ud, "Edge-Local"), (edge_ud2, "Edge-Roaming")):
    if not os.path.isdir(base):
        print(f"[{tag}] 不存在 {base}")
        continue
    dirs = [d for d in os.listdir(base) if d == "Default" or d.startswith("Profile ")]
    print(f"[{tag}] {base} -> profiles {dirs}")
    for d in dirs:
        probe(f"{tag}/{d}", os.path.join(base, d, "Network", "Cookies"))

# 已搬到 .boss-prof 的那份
probe("seeded/.boss-prof", os.path.join(os.environ["USERPROFILE"], ".boss-prof", "Default", "Network", "Cookies"))
