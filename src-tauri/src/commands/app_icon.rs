use crate::error::{AppError, AppResult};
use std::time::Duration;
use tauri::AppHandle;

const POINTER_NOIR_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-noir.png");
const POINTER_GRIS_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-gris.png");
const POINTER_BLANC_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-blanc.png");
const POINTER_MAGNET_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-magnet.png");
const POINTER_ALIEN_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-alien.png");
const POINTER_PASTELLE_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-pastelle.png");
const POINTER_PALADIN_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-paladin.png");
const POINTER_DESERT_SAGE_ICON: &[u8] =
    include_bytes!("../../icons/themes/pointer-desert-sage.png");
const POINTER_SALMON_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-salmon.png");
const POINTER_DARK_PHOTON_ICON: &[u8] =
    include_bytes!("../../icons/themes/pointer-dark-photon.png");
const POINTER_HARMONIC_TIDE_ICON: &[u8] =
    include_bytes!("../../icons/themes/pointer-harmonic-tide.png");
const POINTER_ROCKET_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-rocket.png");
const POINTER_METEOR_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-meteor.png");
const POINTER_DARK_COLA_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-dark-cola.png");
const POINTER_VAMPIRE_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-vampire.png");
const POINTER_MONKEY_PRO_ICON: &[u8] = include_bytes!("../../icons/themes/pointer-monkey-pro.png");

#[tauri::command]
pub async fn set_app_icon_theme(app: AppHandle, theme_id: String) -> AppResult<()> {
    set_application_icon(app, themed_icon_bytes(&theme_id)).await
}

#[tauri::command]
pub fn set_theme_menu_active(app: AppHandle, theme_id: String) -> AppResult<()> {
    crate::menu::set_active_theme(&app, &theme_id)
        .map_err(|e| AppError::Msg(format!("set active theme menu item: {e}")))?;
    Ok(())
}

fn themed_icon_bytes(theme_id: &str) -> &'static [u8] {
    match theme_id {
        "pointer-gris" => POINTER_GRIS_ICON,
        "pointer-blanc" => POINTER_BLANC_ICON,
        "pointer-magnet" => POINTER_MAGNET_ICON,
        "pointer-alien" => POINTER_ALIEN_ICON,
        "pointer-pastelle" => POINTER_PASTELLE_ICON,
        "pointer-paladin" => POINTER_PALADIN_ICON,
        "pointer-desert-sage" => POINTER_DESERT_SAGE_ICON,
        "pointer-salmon" => POINTER_SALMON_ICON,
        "pointer-dark-photon" => POINTER_DARK_PHOTON_ICON,
        "pointer-harmonic-tide" => POINTER_HARMONIC_TIDE_ICON,
        "pointer-rocket" => POINTER_ROCKET_ICON,
        "pointer-meteor" => POINTER_METEOR_ICON,
        "pointer-dark-cola" => POINTER_DARK_COLA_ICON,
        "pointer-vampire" => POINTER_VAMPIRE_ICON,
        "pointer-monkey-pro" => POINTER_MONKEY_PRO_ICON,
        _ => POINTER_NOIR_ICON,
    }
}

#[cfg(target_os = "macos")]
async fn set_application_icon(app: AppHandle, icon: &'static [u8]) -> AppResult<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(set_application_icon_on_main_thread(icon));
    })
    .map_err(|e| AppError::Msg(format!("schedule app icon update: {e}")))?;

    let result = tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| AppError::Msg("timed out waiting for app icon update".into()))?;
    result.map_err(|e| AppError::Msg(format!("wait for app icon update: {e}")))?
}

#[cfg(target_os = "macos")]
fn set_application_icon_on_main_thread(icon: &[u8]) -> AppResult<()> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| AppError::Msg("app icon update must run on main thread".into()))?;
    let data = NSData::with_bytes(icon);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or_else(|| AppError::Msg("failed to decode themed app icon".into()))?;
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn set_application_icon(_app: AppHandle, _icon: &'static [u8]) -> AppResult<()> {
    Ok(())
}
