use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use std::sync::RwLock;

pub const GRAVITY: f32 = 800.0 * 0.0254;
pub const JUMP_SPEED: f32 = 301.993378 * 0.0254;
pub const STAND_WALK_SPEED: f32 = 250.0 * 0.0254;
pub const SLOW_WALK_SPEED: f32 = 130.0 * 0.0254;
pub const CROUCH_SPEED: f32 = 85.0 * 0.0254;

#[derive(Clone, Copy, Debug)]
struct Triangle {
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    min: [f32; 3],
    max: [f32; 3],
}

static COLLISION_TRIS: RwLock<Vec<Triangle>> = RwLock::new(Vec::new());

fn sub(u: [f32; 3], v: [f32; 3]) -> [f32; 3] {
    [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
}

fn dot(u: [f32; 3], v: [f32; 3]) -> f32 {
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
}

fn cross(u: [f32; 3], v: [f32; 3]) -> [f32; 3] {
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

fn ray_triangle(origin: [f32; 3], dir: [f32; 3], tri: &Triangle, max_dist: f32) -> Option<f32> {
    let e1 = sub(tri.b, tri.a);
    let e2 = sub(tri.c, tri.a);
    let h = cross(dir, e2);
    let det = dot(e1, h);
    if det.abs() < 1e-7 {
        return None;
    }
    let inv_det = 1.0 / det;
    let s = sub(origin, tri.a);
    let u = inv_det * dot(s, h);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = inv_det * dot(dir, q);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = inv_det * dot(e2, q);
    if t >= 0.0 && t <= max_dist {
        Some(t)
    } else {
        None
    }
}

pub fn load_triangles(positions: &[f32]) -> bool {
    if positions.len() < 9 || positions.len() % 9 != 0 {
        return false;
    }
    let mut tris = Vec::with_capacity(positions.len() / 9);
    for chunk in positions.chunks_exact(9) {
        let a = [chunk[0], chunk[1], chunk[2]];
        let b = [chunk[3], chunk[4], chunk[5]];
        let c = [chunk[6], chunk[7], chunk[8]];
        let min = [
            a[0].min(b[0]).min(c[0]),
            a[1].min(b[1]).min(c[1]),
            a[2].min(b[2]).min(c[2]),
        ];
        let max = [
            a[0].max(b[0]).max(c[0]),
            a[1].max(b[1]).max(c[1]),
            a[2].max(b[2]).max(c[2]),
        ];
        tris.push(Triangle { a, b, c, min, max });
    }
    if let Ok(mut guard) = COLLISION_TRIS.write() {
        *guard = tris;
        return true;
    }
    false
}

pub fn raycast_slice(origin: [f32; 3], dir: [f32; 3], max_dist: f32) -> Option<f32> {
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len < 1e-8 {
        return None;
    }
    let nd = [dir[0] / len, dir[1] / len, dir[2] / len];
    let guard = COLLISION_TRIS.read().ok()?;
    let mut best = max_dist;
    let mut hit = false;
    for tri in guard.iter() {
        // Quick vertical bounds rejection for downward probes.
        if nd[0] == 0.0 && nd[2] == 0.0 {
            if origin[0] < tri.min[0] || origin[0] > tri.max[0] || origin[2] < tri.min[2] || origin[2] > tri.max[2] {
                continue;
            }
        }
        if let Some(d) = ray_triangle(origin, nd, tri, best) {
            best = d;
            hit = true;
        }
    }
    if hit { Some(best) } else { None }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(len, 4).expect("valid layout");
    unsafe { std_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 4).expect("valid layout");
    unsafe { std_dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn init_collision(ptr: *const f32, float_len: usize) -> u32 {
    if ptr.is_null() || float_len < 9 || float_len % 9 != 0 {
        return 0;
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, float_len) };
    if load_triangles(slice) { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn free_collision() {
    if let Ok(mut guard) = COLLISION_TRIS.write() {
        guard.clear();
    }
}

#[no_mangle]
pub extern "C" fn raycast_world(ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max_dist: f32) -> f32 {
    raycast_slice([ox, oy, oz], [dx, dy, dz], max_dist).unwrap_or(-1.0)
}

#[no_mangle]
pub extern "C" fn step_player(
    x: f32, y: f32, z: f32,
    _vx: f32, mut vy: f32, _vz: f32,
    grounded_in: u32,
    forward: f32, right: f32, yaw: f32,
    jump: u32, crouch: u32, walk: u32,
    dt: f32,
    out_ptr: *mut f32,
) {
    let safe_dt = dt.clamp(0.0, 0.1);
    let speed = if crouch != 0 {
        CROUCH_SPEED
    } else if walk != 0 {
        SLOW_WALK_SPEED
    } else {
        STAND_WALK_SPEED
    };

    let fwd_x = -yaw.sin();
    let fwd_z = -yaw.cos();
    let right_x = yaw.cos();
    let right_z = -yaw.sin();
    let wish_x = fwd_x * forward + right_x * right;
    let wish_z = fwd_z * forward + right_z * right;
    let wish_len = wish_x.hypot(wish_z);
    let (nx, nz) = if wish_len > 1e-5 {
        let denom = wish_len.max(1.0);
        (wish_x / denom, wish_z / denom)
    } else {
        (0.0, 0.0)
    };

    let vx = nx * speed;
    let vz = nz * speed;
    let mut grounded = grounded_in != 0;
    if grounded && jump != 0 {
        vy = JUMP_SPEED;
        grounded = false;
    }
    if !grounded {
        vy -= GRAVITY * safe_dt;
    }

    let next_x = x + vx * safe_dt;
    let mut next_y = y + vy * safe_dt;
    let next_z = z + vz * safe_dt;

    let has_tris = COLLISION_TRIS.read().map(|g| !g.is_empty()).unwrap_or(false);
    if has_tris && vy <= 0.0 {
        let probe_y = y + if crouch != 0 { 0.55 } else { 0.9 };
        if let Some(hit) = raycast_slice([next_x, probe_y, next_z], [0.0, -1.0, 0.0], probe_y - next_y + 0.05) {
            let floor_y = probe_y - hit;
            if next_y <= floor_y {
                next_y = floor_y;
                vy = 0.0;
                grounded = true;
            }
        } else if next_y < y {
            grounded = false;
        }
    } else if !has_tris && next_y <= 0.0 {
        next_y = 0.0;
        vy = 0.0;
        grounded = true;
    }

    if !out_ptr.is_null() {
        let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, 7) };
        out[0] = next_x;
        out[1] = next_y;
        out[2] = next_z;
        out[3] = vx;
        out[4] = vy;
        out[5] = vz;
        out[6] = if grounded { 1.0 } else { 0.0 };
    }
}
