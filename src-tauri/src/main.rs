#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_system_idle_seconds])
        .run(tauri::generate_context!())
    .expect("error while running togather");
}
