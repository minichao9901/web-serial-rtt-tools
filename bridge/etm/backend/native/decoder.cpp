// OpenCSD integration. Output is JSONL; no inferred instructions are invented here.
#include "opencsd/c_api/opencsd_c_api.h"
#include <fstream>
#ifdef _WIN32
#include <windows.h>
#endif
#include <iostream>
#include <sstream>
#include <vector>
#include <stdexcept>
#include <iomanip>

static std::string quote(const char *text) {
    std::ostringstream s; s << '"';
    for (const unsigned char *p=(const unsigned char *)text; *p; ++p) {
        if (*p=='"' || *p=='\\') s << '\\' << *p;
        else if (*p=='\n') s << "\\n";
        else if (*p=='\r') s << "\\r";
        else if (*p=='\t') s << "\\t";
        else if (*p<32) s << "\\u" << std::hex << std::setw(4) << std::setfill('0') << (unsigned)*p << std::dec;
        else s << *p;
    }
    s << '"'; return s.str();
}
static ocsd_trace_protocol_t packet_protocol = OCSD_PROTOCOL_ETMV4I;
static ocsd_datapath_resp_t element(const void *, ocsd_trc_index_t index, uint8_t id, const ocsd_generic_trace_elem *e) {
    char text[2048] = {0}; ocsd_gen_elem_str(e,text,sizeof(text));
    const bool range=e->elem_type==OCSD_GEN_TRC_ELEM_INSTR_RANGE || e->elem_type==OCSD_GEN_TRC_ELEM_I_RANGE_NOPATH;
    const bool exception=e->elem_type==OCSD_GEN_TRC_ELEM_EXCEPTION;
    uint32_t payload=0;
    if(range) payload=e->num_instr_range;
    else if(exception) payload=e->exception_number;
    else if(e->elem_type==OCSD_GEN_TRC_ELEM_NO_SYNC || e->elem_type==OCSD_GEN_TRC_ELEM_EO_TRACE) payload=e->unsync_eot_info;
    else if(e->elem_type==OCSD_GEN_TRC_ELEM_TRACE_ON) payload=e->trace_on_reason;
    std::cout << "{\"kind\":\"element\",\"offset\":" << index << ",\"id\":" << (unsigned)id
      << ",\"type\":" << (int)e->elem_type << ",\"start\":" << ((range || e->elem_type==OCSD_GEN_TRC_ELEM_ADDR_NACC)?e->st_addr:0)
      << ",\"end\":" << ((range || (exception && e->excep_ret_addr))?e->en_addr:0)
      << ",\"isa\":" << (range?(int)e->isa:0) << ",\"flags\":" << e->flag_bits
      << ",\"cycleCount\":" << (e->has_cc?e->cycle_count:0) << ",\"timestamp\":" << ((e->has_ts || e->elem_type==OCSD_GEN_TRC_ELEM_TIMESTAMP)?e->timestamp:0)
      << ",\"lastExecuted\":" << (range?e->last_instr_exec:0) << ",\"lastConditional\":" << (range?e->last_instr_cond:0)
      << ",\"lastType\":" << (range?(int)e->last_i_type:0) << ",\"lastSubtype\":" << (range?(int)e->last_i_subtype:0)
      << ",\"payload\":" << payload << ",\"text\":" << quote(text) << "}\n";
    return OCSD_RESP_CONT;
}
static void packet(const void *, ocsd_datapath_op_t op, ocsd_trc_index_t index, const void *pkt, uint32_t size, const uint8_t *data) {
    if(op!=OCSD_OP_DATA || !pkt) return;
    char text[2048]={0}; ocsd_pkt_str(packet_protocol,pkt,text,sizeof(text));
    std::ostringstream hex;
    for(uint32_t i=0;i<size;i++) hex << std::hex << std::setw(2) << std::setfill('0') << (unsigned)data[i];
    std::cout << "{\"kind\":\"packet\",\"offset\":" << index << ",\"size\":" << size
      << ",\"hex\":" << quote(hex.str().c_str()) << ",\"text\":" << quote(text) << "}\n";
}
#ifdef _WIN32
static std::wstring file_path(const std::string &path) {
    const int length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),(int)path.size(),0,0);
    if(!length) throw std::runtime_error("Invalid UTF-8 path");
    std::wstring wide(length,0); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),(int)path.size(),&wide[0],length); return wide;
}
#else
static const std::string &file_path(const std::string &path) { return path; }
#endif
static std::vector<uint8_t> read(const std::string &path) {
    std::ifstream f(file_path(path).c_str(),std::ios::binary);
    if(!f) throw std::runtime_error("Cannot read "+path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),std::istreambuf_iterator<char>());
}
static void check(ocsd_err_t code) { if(code!=OCSD_OK) throw std::runtime_error("OpenCSD API error "+std::to_string(code)); }
static int decode_main(int argc,char **argv) {
    if(argc!=3) { std::cerr << "Usage: etm_decode trace.bin config-and-memory.txt\n"; return 2; }
    dcd_tree_handle_t tree=0;
    try {
        std::ifstream config(file_path(argv[2]).c_str()); if(!config) throw std::runtime_error("Cannot read config");
        uint32_t regs[11]={0}; std::string value;
        if(!(config>>value)) throw std::runtime_error("Missing protocol/register");
        const bool v3=value=="ETMv3";
        unsigned first=0;
        if(!v3) { regs[0]=std::stoul(value,0,0); first=1; }
        for(unsigned i=first;i<(v3?4u:11u);i++) { if(!(config>>value)) throw std::runtime_error("Missing register"); regs[i]=std::stoul(value,0,0); }
        ocsd_etmv4_cfg c={};
        c.reg_idr0=regs[0]; c.reg_idr1=regs[1]; c.reg_idr2=regs[2];
        c.reg_idr8=regs[3]; c.reg_idr9=regs[4]; c.reg_idr10=regs[5]; c.reg_idr11=regs[6]; c.reg_idr12=regs[7]; c.reg_idr13=regs[8];
        c.reg_configr=regs[9]; c.reg_traceidr=regs[10]; c.arch_ver=ARCH_V7; c.core_prof=profile_CortexM;
        tree=ocsd_create_dcd_tree(OCSD_TRC_SRC_SINGLE,0); if(!tree) throw std::runtime_error("No decode tree");
        check(ocsd_dt_set_gen_elem_outfn(tree,element,0));
        unsigned char id=0;
        if(v3) {
            ocsd_etmv3_cfg c3={};
            c3.reg_idr=regs[0]; c3.reg_ctrl=regs[1]; c3.reg_ccer=regs[2]; c3.reg_trc_id=regs[3];
            c3.arch_ver=ARCH_V7; c3.core_prof=profile_CortexM;
            packet_protocol=OCSD_PROTOCOL_ETMV3;
            check(ocsd_dt_create_decoder(tree,OCSD_BUILTIN_DCD_ETMV3,OCSD_CREATE_FLG_FULL_DECODER,&c3,&id));
        } else {
            check(ocsd_dt_create_decoder(tree,OCSD_BUILTIN_DCD_ETMV4I,OCSD_CREATE_FLG_FULL_DECODER,&c,&id));
        }
        check(ocsd_dt_attach_packet_callback(tree,id,OCSD_C_API_CB_PKT_MON,(void *)packet,0));
        std::vector<std::vector<uint8_t> > images;
        while(config>>value) {
            uint64_t address=std::stoull(value,0,0); std::string file; std::getline(config,file);
            file=file.substr(file.find_first_not_of(" \t")); if(!file.empty() && file.back()=='\r') file.pop_back();
            images.push_back(read(file));
            check(ocsd_dt_add_buffer_mem_acc(tree,address,OCSD_MEM_SPACE_ANY,images.back().data(),(uint32_t)images.back().size()));
        }
        const auto raw=read(argv[1]); uint32_t done=0;
        auto response=ocsd_dt_process_data(tree,OCSD_OP_DATA,0,(uint32_t)raw.size(),raw.data(),&done);
        if(response>=OCSD_RESP_FATAL_NOT_INIT || done!=raw.size()) throw std::runtime_error("Decode stopped at "+std::to_string(done)+" / "+std::to_string(raw.size())+" response "+std::to_string((int)response));
        response=ocsd_dt_process_data(tree,OCSD_OP_EOT,done,0,0,0);
        if(response>=OCSD_RESP_FATAL_NOT_INIT) throw std::runtime_error("Decoder end-of-trace error");
        char error[4096]={0}; uint8_t chan=0; ocsd_trc_index_t index=0;
        auto code=ocsd_get_last_err(&index,&chan,error,sizeof(error));
        std::cout << "{\"kind\":\"status\",\"processed\":" << done << ",\"library\":" << quote(ocsd_get_version_str())
          << ",\"lastErrorCode\":" << (int)code << ",\"lastError\":" << quote(error) << "}\n";
        ocsd_destroy_dcd_tree(tree); return 0;
    } catch(const std::exception &e) { if(tree) ocsd_destroy_dcd_tree(tree); std::cerr << e.what() << '\n'; return 1; }
}

#ifdef _WIN32
int wmain(int argc,wchar_t **wide) {
    std::vector<std::string> utf8; std::vector<char *> argv;
    for(int i=0;i<argc;i++) {
        int size=WideCharToMultiByte(CP_UTF8,0,wide[i],-1,0,0,0,0); std::string value(size,0);
        WideCharToMultiByte(CP_UTF8,0,wide[i],-1,&value[0],size,0,0); value.resize(size-1); utf8.push_back(value);
    }
    for(auto &value:utf8) argv.push_back(&value[0]);
    return decode_main(argc,argv.data());
}
#else
int main(int argc,char **argv) { return decode_main(argc,argv); }
#endif
