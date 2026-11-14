require "sequel"
require "fileutils"

module DB
  ROOT = File.expand_path("..", __dir__)
  PATH = ENV.fetch("DATABASE_PATH", File.join(ROOT, "data", "unesco.sqlite3"))

  def self.connection
    @connection ||= begin
      FileUtils.mkdir_p(File.dirname(PATH))
      db = Sequel.sqlite(PATH)
      db.run("PRAGMA journal_mode = WAL")
      migrate!(db)
      db
    end
  end

  def self.migrate!(db)
    db.create_table?(:sites) do
      Integer :id_no, primary_key: true            # UNESCO reference number
      String  :name, null: false
      String  :category, null: false               # Cultural / Natural / Mixed
      TrueClass :danger, default: false
      Integer :year_inscribed
      String  :countries                           # "France, Spain"
      String  :iso_codes                           # "FR,ES"
      String  :region
      Float   :lat
      Float   :lon
      TrueClass :transboundary, default: false
      String  :criteria
      Float   :area_hectares
      String  :unesco_summary, text: true          # official short text — used only as facts for the LLM
      String  :unesco_image_url
      String  :unesco_image_credit

      String  :wikidata_id
      String  :wikipedia_title
      String  :wikipedia_extract, text: true
      String  :wikipedia_fallbacks, text: true      # JSON list of component-part articles
      String  :wikipedia_thumb                     # article lead image (thumbnail)
      String  :commons_image                       # P18 file name
      String  :image_url                           # chosen display image (thumbnail)
      String  :image_page_url                      # where the image credit links

      String  :description, text: true             # generated, written for this map
      String  :description_model
      DateTime :updated_at
    end
    db.alter_table(:sites) { add_column :wikipedia_fallbacks, String, text: true } unless db[:sites].columns.include?(:wikipedia_fallbacks)
  end
end
