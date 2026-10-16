// The scope vocabulary agrees with the console's list and with the CHECK the
// newest migration to restate it puts on data_api_keys.

mod common;

use data_api_rs::scopes::DATA_API_SCOPES;

/// Every single-quoted string in `s`, in order.
fn quoted(s: &str) -> Vec<String> {
    s.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn is_the_same_list_in_the_same_order_as_the_shared_one() {
    let src = common::read_repo_file("packages/shared/src/utils/data-api-key.ts");
    let start = src
        .find("export const DATA_API_SCOPES = [")
        .expect("the shared list");
    let list = &src[start..start + src[start..].find("] as const").expect("its end")];
    assert_eq!(quoted(list), DATA_API_SCOPES);
}

#[test]
fn is_exactly_what_the_newest_vocabulary_check_admits() {
    let marker = "ADD CONSTRAINT data_api_keys_scope_vocabulary";
    // The last migration to restate the CHECK is the one in force.
    let dir = format!("{}/../../supabase/migrations", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("the migrations directory")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| {
            name.len() > 10
                && name.as_bytes()[..5].iter().all(u8::is_ascii_digit)
                && name.as_bytes()[5] == b'_'
                && name.ends_with(".sql")
        })
        .collect();
    names.sort();
    let sql = names
        .iter()
        .map(|name| common::read_repo_file(&format!("supabase/migrations/{name}")))
        .rfind(|text| text.contains(marker))
        .expect("a migration that sets the vocabulary");
    let after = &sql[sql.find(marker).expect("the constraint") + marker.len()..];
    let check = after.trim_start();
    assert!(
        check.starts_with("CHECK (scopes <@ ARRAY["),
        "{}",
        &check[..40.min(check.len())]
    );
    let array = &check["CHECK (scopes <@ ARRAY[".len()..];
    let array = &array[..array.find(']').expect("the array's end")];
    assert_eq!(quoted(array), DATA_API_SCOPES);
}
