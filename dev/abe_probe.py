import os, sys, sqlite3, shutil, tempfile, datetime

def dump(label, dbpath):
    if not os.path.exists(dbpath):
        print(f"[{label}] 无 Cookies 文件: {dbpath}")
        return
    tmp = os.path.join(tempfile.gettempdir(), "abeprobe_%d.db" % abs(hash(dbpath)))
    try:
        shutil.copy2(dbpath, tmp)
    except Exception as e:
        print(f"[{label}] 复制失败: {e}")
        return
    con = sqlite3.connect(tmp)
    rows = con.execute(
        "select host_key,name,is_persistent,expires_utc,length(encrypted_value),hex(substr(encrypted_value,1,3)) "
        "from cookies where host_key like '%zhipin%' order by name"
    ).fetchall()
    print(f"[{label}] zhipin cookies = {len(rows)}")
    for host, name, pers, exp, n, pre in rows:
        try:
            dt = (datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=exp)).strftime("%Y-%m-%d")
        except Exception:
            dt = "?"
        print(f"    {name:12s} persistent={pers} exp={dt} {n:4d}B prefix={pre}")
    con.close()
    try:
        os.remove(tmp)
    except OSError:
        pass

for arg in sys.argv[1:]:
    label, path = arg.split("|", 1)
    dump(label, path)
