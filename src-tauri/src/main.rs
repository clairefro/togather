#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[tauri::command]
fn get_system_idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event_source::CGEventSourceStateID;

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(
                stateID: CGEventSourceStateID,
                eventType: u32,
            ) -> f64;
        }

        const K_CG_ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;

        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(
                CGEventSourceStateID::CombinedSessionState,
                K_CG_ANY_INPUT_EVENT_TYPE,
            )
        };

        return if seconds.is_finite() {
            Some(seconds.max(0.0))
        } else {
            None
        };
    }

    #[cfg(target_os = "windows")]
    {
        use std::mem::size_of;
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetLastInputInfo, LASTINPUTINFO,
        };

        let mut last_input = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };

        let success = unsafe { GetLastInputInfo(&mut last_input) };
        if success == 0 {
            return None;
        }

        let elapsed_ms = unsafe { GetTickCount() }.wrapping_sub(last_input.dwTime);
        return Some(f64::from(elapsed_ms) / 1_000.0);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_system_idle_seconds])
        .setup(|app| {
            let window = if let Some(existing) = app.get_webview_window("main") {
                existing
            } else {
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("togather")
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .shadow(false)
                    .build()
                    .expect("failed to create main window")
            };

            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running togather");
}
