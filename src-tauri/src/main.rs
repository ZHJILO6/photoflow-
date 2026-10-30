#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            commands::start_card_watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_library,
            commands::match_files,
            commands::quick_export_preview,
            commands::copy_matched,
            commands::scan_card,
            commands::import_card,
            commands::import_card_preview,
            commands::write_match_csv,
            commands::thumbnail_data_url,
            commands::focus_preview_data_url,
            commands::scan_export_sources,
            commands::scan_archive,
            commands::open_archive_dir,
            commands::search_archive,
            commands::find_archive_duplicates,
            commands::cleanup_archive_duplicates,
            commands::cleanup_empty_dirs,
            commands::cull_list,
            commands::write_cull_csv,
            commands::apply_cull_ratings,
            commands::copy_cull_kept,
            commands::storage_devices,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PhotoFlow Picker");
}
