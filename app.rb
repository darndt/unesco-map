require "sinatra/base"
require "json"
require_relative "lib/db"
require_relative "lib/importers"

class App < Sinatra::Base
  set :root, __dir__
  set :public_folder, File.join(__dir__, "public")
  set :static_cache_control, [:public, max_age: 300]

  SITES = DB.connection[:sites]

  get "/" do
    send_file File.join(settings.public_folder, "index.html")
  end

  # Lightweight GeoJSON for the map layer, search and filters.
  get "/api/sites.geojson" do
    content_type "application/geo+json"
    cache_control :public, max_age: 600
    features = SITES.select(:id_no, :name, :category, :danger, :countries, :year_inscribed, :lat, :lon)
                    .order(:id_no).map do |s|
      {
        type: "Feature",
        id: s[:id_no],
        geometry: { type: "Point", coordinates: [s[:lon].round(5), s[:lat].round(5)] },
        properties: {
          id: s[:id_no], name: s[:name], category: s[:category],
          danger: s[:danger] ? 1 : 0, countries: s[:countries], year: s[:year_inscribed]
        }
      }
    end
    JSON.generate(type: "FeatureCollection", features: features)
  end

  # Full detail for one popup. The frontend asks for "668.json" so the same
  # relative URL works against the static export on GitHub Pages.
  get "/api/sites/:id" do
    s = SITES.where(id_no: params[:id].to_i).first or halt 404, { error: "not found" }.to_json
    content_type :json
    cache_control :public, max_age: 600
    JSON.generate(
      id: s[:id_no],
      name: s[:name],
      category: s[:category],
      danger: s[:danger],
      year: s[:year_inscribed],
      countries: s[:countries],
      transboundary: s[:transboundary],
      criteria: s[:criteria],
      description: s[:description] || excerpt(s[:wikipedia_extract]),
      description_generated: !s[:description].nil?,
      image: s[:image_url],
      image_page: s[:image_page_url],
      unesco_url: "https://whc.unesco.org/en/list/#{s[:id_no]}/",
      wikipedia_url: s[:wikipedia_title] && Importers::Wikipedia.wiki_url(s[:wikipedia_title]),
      wikidata_url: s[:wikidata_id] && "https://www.wikidata.org/wiki/#{s[:wikidata_id]}"
    )
  end

  helpers do
    # Fallback until Claude descriptions exist: first ~2 sentences of Wikipedia.
    def excerpt(text)
      return nil if text.nil? || text.empty?
      text = text.gsub(/\s*\((?:[^()]|\([^()]*\))*\)/, "")   # drop pronunciations / native names
      sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/)
      out = +""
      sentences.each do |s|
        break if out.length > 220
        out << " " unless out.empty?
        out << s
      end
      out
    end
  end
end
